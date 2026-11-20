// -*-Mode: C++;-*-
//
// Scene AO / lighting properties in the qsc file: a file saved before the
// Fast GI AO (no aoMethod) must keep its former GTAO look, and the new
// properties must survive a save / load round trip.
//

#include <gtest/gtest.h>
#include <common.h>

#include "qsys/Scene.hpp"
#include "qsys/SceneManager.hpp"
#include "qsys/TTYView.hpp"
#include "qsys/View.hpp"

#include <qlib/LDOM2Stream.hpp>
#include <qlib/LDOM2Tree.hpp>
#include <qlib/PipeStream.hpp>

#include <string>
#include <vector>

using qsys::Scene;
using qsys::SceneManager;
using qsys::ScenePtr;

namespace {

class TTYViewFactory : public qsys::ViewFactory
{
public:
    qsys::View *create() override { return new qsys::TTYView(); }
};

std::string drainPipe(qlib::PipeStreamImpl &impl)
{
    std::string result;
    char buf[256];
    while (impl.ready()) {
        int n = impl.read(buf, 0, sizeof buf);
        if (n <= 0) break;
        result.append(buf, static_cast<size_t>(n));
    }
    return result;
}

/// Save the scene's properties as qsc XML text (Scene::writeTo2).
std::string saveScene(const ScenePtr &pScene)
{
    qlib::LDom2Tree tree("scene");
    pScene->writeTo2(tree.top());
    auto impl = qlib::sp<qlib::PipeStreamImpl>(new qlib::PipeStreamImpl());
    qlib::PipeOutStream raw_out;
    raw_out.setImpl(impl);
    qlib::LDom2OutStream out(raw_out);
    out.write(&tree);
    impl->o_close();
    return drainPipe(*impl);
}

/// Load qsc XML text into the scene (Scene::readFrom2).
void loadScene(const ScenePtr &pScene, const std::string &xml)
{
    auto impl = qlib::sp<qlib::PipeStreamImpl>(new qlib::PipeStreamImpl());
    impl->write(xml.c_str(), 0, static_cast<int>(xml.size()));
    impl->o_close();
    qlib::PipeInStream raw_in;
    raw_in.setImpl(impl);
    qlib::LDom2InStream in(raw_in);
    qlib::LDom2Tree tree;
    in.read(tree);
    pScene->readFrom2(tree.top());
}

}  // namespace

class SceneAOCompatTest : public ::testing::Test
{
protected:
    void SetUp() override { qsys::View::setViewFactory(new TTYViewFactory()); }

    void TearDown() override
    {
        for (auto &p : m_scenes) {
            const qlib::uid_t uid = p->getUID();
            p = ScenePtr();
            SceneManager::getInstance()->destroyScene(uid);
        }
        m_scenes.clear();
        qsys::View::setViewFactory(nullptr);
    }

    ScenePtr newScene()
    {
        m_scenes.push_back(SceneManager::getInstance()->createScene());
        return m_scenes.back();
    }

    std::vector<ScenePtr> m_scenes;
};

// A file without aoMethod loads as GTAO with the former defaults for the AO
// properties it does not carry, keeps the ones it does, and a resave writes
// them so the next load (now with aoMethod) gives the same look.
TEST_F(SceneAOCompatTest, LegacyFileKeepsGtaoLookAcrossResave)
{
    ScenePtr pLegacy = newScene();
    loadScene(pLegacy, "<scene aoEnabled=\"true\" aoRadius=\"6\"/>");
    EXPECT_EQ(pLegacy->getAOMethod(), Scene::AOM_GTAO);
    EXPECT_DOUBLE_EQ(pLegacy->getAORadius(), 6.0);  // carried by the file
    EXPECT_EQ(pLegacy->getAOSlices(), 9);           // former defaults
    EXPECT_EQ(pLegacy->getAOSteps(), 3);
    EXPECT_FALSE(pLegacy->isAOHalfRes());

    const std::string resaved = saveScene(pLegacy);
    EXPECT_NE(resaved.find("aoMethod"), std::string::npos) << resaved;

    ScenePtr pReloaded = newScene();
    loadScene(pReloaded, resaved);
    EXPECT_EQ(pReloaded->getAOMethod(), Scene::AOM_GTAO);
    EXPECT_DOUBLE_EQ(pReloaded->getAORadius(), 6.0);
    EXPECT_EQ(pReloaded->getAOSlices(), 9);
    EXPECT_EQ(pReloaded->getAOSteps(), 3);
    EXPECT_FALSE(pReloaded->isAOHalfRes());
}

// A new scene is saved with aoMethod even at its default (Fast GI), so it
// reloads as Fast GI with the current defaults; a changed brightness
// round-trips, and the default one is not written.
TEST_F(SceneAOCompatTest, FastGISceneRoundTrips)
{
    ScenePtr pSrc = newScene();
    ASSERT_EQ(pSrc->getAOMethod(), Scene::AOM_FASTGI);
    const std::string plain = saveScene(pSrc);
    EXPECT_NE(plain.find("aoMethod"), std::string::npos) << plain;
    EXPECT_EQ(plain.find("lightBrightness"), std::string::npos) << plain;

    // Through the property interface, as the inspector does (it clears the
    // property's default flag, which decides whether it is written).
    ASSERT_TRUE(pSrc->setPropReal("lightBrightness", 0.8));
    ASSERT_TRUE(pSrc->setPropReal("aoProbeStrength", 0.5));
    ScenePtr pDst = newScene();
    loadScene(pDst, saveScene(pSrc));
    EXPECT_EQ(pDst->getAOMethod(), Scene::AOM_FASTGI);
    EXPECT_DOUBLE_EQ(pDst->getAORadius(), pSrc->getAORadius());
    EXPECT_EQ(pDst->getAOSteps(), pSrc->getAOSteps());
    EXPECT_DOUBLE_EQ(pDst->getLightBrightness(), 0.8);
    EXPECT_DOUBLE_EQ(pDst->getAOProbeStrength(), 0.5);
}
