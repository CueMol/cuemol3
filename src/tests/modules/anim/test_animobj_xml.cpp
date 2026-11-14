#include <gtest/gtest.h>
#include <common.h>

#include "anim/SimpleSpin.hpp"

#include <qsys/Scene.hpp>
#include <qsys/SceneManager.hpp>
#include <qsys/StreamManager.hpp>
#include <qlib/LByteArray.hpp>

using anim::SimpleSpin;
using qsys::StreamManager;

// Times are in nanoseconds; the XML keeps milliseconds.
static qlib::time_value MS(int ms) { return qlib::time_value(ms) * 1000000; }

// An animation element goes through toXML / fromXML (what copy and paste in
// the Animation panel do) as the same class, with its common and its own
// properties.
TEST(AnimObjXML, RoundTripKeepsClassAndProperties)
{
    qsys::ScenePtr pScene = qsys::SceneManager::getInstance()->createScene();
    const qlib::uid_t sceneID = pScene->getUID();

    qlib::LScrSp<SimpleSpin> pSpin(MB_NEW SimpleSpin());
    pSpin->setPropStr("name", "spin0");
    pSpin->setPropStr("timeRefName", "prev");
    pSpin->setPropReal("angle", 180.0);
    pSpin->setRelStart(MS(250));
    pSpin->setRelEnd(MS(1500));

    qlib::LByteArrayPtr pXml = StreamManager::getInstance()->toXML(pSpin);
    ASSERT_FALSE(pXml.isnull());
    std::string xml(reinterpret_cast<const char *>(pXml->data()), pXml->size());
    EXPECT_NE(xml.find("<motion"), std::string::npos);

    qlib::LScrObjBasePtr pSObj = StreamManager::getInstance()->fromXML(pXml, sceneID);
    qlib::LScrSp<SimpleSpin> pCopy(pSObj, qlib::no_throw_tag());
    ASSERT_FALSE(pCopy.isnull());
    EXPECT_NE(pCopy.get(), pSpin.get());

    LString name;
    pCopy->getPropStr("name", name);
    EXPECT_EQ(name, LString("spin0"));
    EXPECT_EQ(pCopy->getTimeRefName(), LString("prev"));
    EXPECT_DOUBLE_EQ(pCopy->getAngle(), 180.0);
    EXPECT_EQ(pCopy->getRelStart(), MS(250));
    EXPECT_EQ(pCopy->getRelEnd(), MS(1500));

    pScene = qsys::ScenePtr();
    qsys::SceneManager::getInstance()->destroyScene(sceneID);
}
