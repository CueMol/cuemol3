// -*-Mode: C++;-*-
//
// Scene occluder generation (Scene::getOccluderGen): the Fast GI ambient
// probes rebake when it moves, so it must move on every change of the drawn
// geometry and stay put on a camera move (the probes once re-checked the whole
// scene on a timer while the view rotated).
//

#include <gtest/gtest.h>
#include <common.h>

#include "qsys/AmbientProbeVolume.hpp"
#include "qsys/Object.hpp"
#include "qsys/ObjectEvent.hpp"
#include "qsys/Renderer.hpp"
#include "qsys/Scene.hpp"
#include "qsys/SceneManager.hpp"
#include "qsys/TTYView.hpp"
#include "qsys/View.hpp"

#include <qlib/LQuat.hpp>
#include <qlib/Vector4D.hpp>

#include <algorithm>
#include <cmath>

namespace {

class TTYViewFactory : public qsys::ViewFactory
{
public:
    qsys::View *create() override { return new qsys::TTYView(); }
};

class GenTestObject : public qsys::Object
{
public:
    qlib::LCloneableObject *clone() const override { return nullptr; }
};

class GenTestRenderer : public qsys::Renderer
{
public:
    const char *getTypeName() const override { return "gentest"; }
    bool isCompatibleObj(qsys::ObjectPtr) const override { return true; }
    qlib::Vector4D getCenter() const override { return qlib::Vector4D(); }
    void display(gfx::DisplayContext *) override {}
    void unloading() override {}
    qlib::LCloneableObject *clone() const override { return nullptr; }
};

}  // namespace

class SceneOccluderGenTest : public ::testing::Test
{
protected:
    qsys::ScenePtr m_pScene;
    qsys::ObjectPtr m_pObj;

    void SetUp() override
    {
        qsys::View::setViewFactory(new TTYViewFactory());
        m_pScene = qsys::SceneManager::getInstance()->createScene();
        m_pObj = qsys::ObjectPtr(MB_NEW GenTestObject());
        m_pScene->addObject(m_pObj);
    }

    void TearDown() override
    {
        const qlib::uid_t uid = m_pScene->getUID();
        m_pObj = qsys::ObjectPtr();
        m_pScene = qsys::ScenePtr();
        qsys::SceneManager::getInstance()->destroyScene(uid);
        qsys::View::setViewFactory(nullptr);
    }

    /// True when f moved the occluder generation.
    template <typename F>
    bool moves(F f)
    {
        const unsigned int gen = m_pScene->getOccluderGen();
        f();
        return m_pScene->getOccluderGen() != gen;
    }
};

TEST_F(SceneOccluderGenTest, GeometryChangesMoveIt)
{
    qsys::RendererPtr pRend;
    EXPECT_TRUE(moves([&] {
        pRend = qsys::RendererPtr(MB_NEW GenTestRenderer());
        m_pObj->attachRenderer(pRend);
    }));
    EXPECT_TRUE(moves([&] { pRend->setPropBool("visible", false); }));
    // An alpha change moves the renderer between a veil and the background,
    // which the probes leave out or bake.
    EXPECT_TRUE(moves([&] { pRend->setPropReal("alpha", 0.5); }));
    EXPECT_TRUE(moves([&] { m_pObj->setPropBool("visible", false); }));
    // What MolCoord::fireAtomsMoved sends (MD playback, morphing).
    EXPECT_TRUE(moves([&] {
        qsys::ObjectEvent ev;
        ev.setType(qsys::ObjectEvent::OBE_CHANGED);
        ev.setTarget(m_pObj->getUID());
        ev.setDescr("atomsMoved");
        m_pObj->fireObjectEvent(ev);
    }));
    EXPECT_TRUE(moves([&] { m_pObj->destroyRenderer(pRend->getUID()); }));
    EXPECT_TRUE(moves([&] { m_pScene->destroyObject(m_pObj->getUID()); }));
}

TEST_F(SceneOccluderGenTest, CameraAndSceneSettingsLeaveIt)
{
    qsys::ViewPtr pView = m_pScene->createView();
    ASSERT_FALSE(pView.isnull());
    EXPECT_FALSE(moves([&] {
        pView->setRotQuat(qlib::LQuat(qlib::Vector4D(0, 1, 0), 0.5));
        pView->setZoom(30.0);
        pView->setViewCenter(qlib::Vector4D(1, 2, 3));
        m_pScene->setPropReal("aoBounce", 0.3);
    }));
}

// The probe atlas is (nx * nz) x ny texels: a large occluder (a map surface)
// widens the spacing until both sides fit, and a small one keeps it.
TEST(AmbientProbeVolumeTest, FitSpacingKeepsAtlasWithinLimit)
{
    const int pad = 2, maxAtlas = qsys::AmbientProbeVolume::kMaxAtlasSize;
    auto atlasSide = [pad](const double ext[3], double h) {
        int n[3];
        for (int a = 0; a < 3; ++a) n[a] = int(std::ceil(ext[a] / h)) + 2 * pad;
        return std::max(n[0] * n[2], n[1]);
    };

    const double small[3] = {40.0, 40.0, 40.0};
    EXPECT_EQ(qsys::AmbientProbeVolume::fitSpacing(small, 3.0, pad, maxAtlas), 3.0);

    // Wide in x/z (the width) and long in y (the height).
    const double wide[3] = {500.0, 50.0, 500.0};
    const double tall[3] = {10.0, 30000.0, 10.0};
    for (const double *ext : {wide, tall}) {
        const double h = qsys::AmbientProbeVolume::fitSpacing(ext, 3.0, pad, maxAtlas);
        EXPECT_GT(h, 3.0);
        EXPECT_LE(atlasSide(ext, h), maxAtlas);
    }
}
