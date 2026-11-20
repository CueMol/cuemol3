// -*-Mode: C++;-*-
//
// Scene occluder generation (Scene::getOccluderGen): the Fast GI ambient
// probes rebake when it moves, so it must move on every change of the drawn
// geometry and stay put on a camera move (the probes once re-checked the whole
// scene on a timer while the view rotated).
//

#include <gtest/gtest.h>
#include <common.h>

#include "qsys/Object.hpp"
#include "qsys/ObjectEvent.hpp"
#include "qsys/Renderer.hpp"
#include "qsys/Scene.hpp"
#include "qsys/SceneManager.hpp"
#include "qsys/TTYView.hpp"
#include "qsys/View.hpp"

#include <qlib/LQuat.hpp>
#include <qlib/Vector4D.hpp>

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
