// -*-Mode: C++;-*-
//
// Tests for CPK2Renderer property defaults and basic behavior.
//

#include <gtest/gtest.h>
#include <common.h>
#include "molvis/CPK2Renderer.hpp"
#include "molstr/MolAtom.hpp"
#include "molstr/MolCoord.hpp"
#include <qsys/AmbientProbeVolume.hpp>
#include <qsys/Scene.hpp>
#include <qsys/SceneManager.hpp>
#include <qsys/style/StyleFile.hpp>

#include <vector>

using molvis::CPK2Renderer;

// ---- getTypeName ----

TEST(CPK2RendererTest, GetTypeNameIsCpk)
{
    CPK2Renderer r;
    EXPECT_STREQ(r.getTypeName(), "cpk");
}

// ---- isRendBond ----

TEST(CPK2RendererTest, IsRendBondFalse)
{
    CPK2Renderer r;
    EXPECT_FALSE(r.isRendBond());
}

// ---- getGLRenderMode ----

TEST(CPK2RendererTest, DefaultGLRenderModeIsZero)
{
    CPK2Renderer r;
    EXPECT_EQ(r.getGLRenderMode(), CPK2Renderer::REND_DEFAULT);
}

// ---- setDetail / getDetail ----

TEST(CPK2RendererTest, SetDetail)
{
    CPK2Renderer r;
    r.setDetail(5);
    EXPECT_EQ(r.getDetail(), 5);
}

// ---- invalidateDisplayCache does not crash before init ----

TEST(CPK2RendererTest, InvalidateBeforeInitDoesNotCrash)
{
    CPK2Renderer r;
    EXPECT_NO_FATAL_FAILURE(r.invalidateDisplayCache());
}

// ---- Fast GI probe grid: only lit renderers drawn with a normal occlude ----

// A lines-only renderer and a renderer whose material is lit by the ambient
// light alone are drawn without a normal and discarded in the probe bake, so
// their atoms must not widen the probe grid either.
TEST(CPK2RendererTest, ProbeGridSkipsLineAndUnlitRenderers)
{
    qsys::ScenePtr pScene = qsys::SceneManager::getInstance()->createScene();
    // The materials are defined in default_style.xml, next to the sysconfig.
    LString conf(CUEMOL2_SYSCONFIG_PATH);
    qsys::StyleFile sfile;
    sfile.loadFile(conf.substr(0, conf.lastIndexOf('/')) + "/default_style.xml",
                   pScene->getUID());

    molstr::MolCoordPtr pMol(MB_NEW molstr::MolCoord());
    for (int i = 0; i < 2; ++i) {
        molstr::MolAtomPtr pAtom(MB_NEW molstr::MolAtom());
        pAtom->setChainName("A");
        pAtom->setResName("ALA");
        pAtom->setResIndex(molstr::ResidIndex(i + 1));
        pAtom->setName("CA");
        pAtom->setElementName("C");
        pAtom->setPos(qlib::Vector4D(4.0 * i, 0.0, 0.0));
        pMol->appendAtom(pAtom);
    }
    pScene->addObject(pMol);
    qsys::RendererPtr pCpk = pMol->createRenderer("cpk");
    ASSERT_FALSE(pMol->createRenderer("simple").isnull());

    std::vector<qlib::Vector4D> sph;
    qsys::AmbientProbeVolume::collectOccluderSpheres(pScene, sph);
    EXPECT_EQ(sph.size(), 2u) << "the cpk atoms only";

    pCpk->setDefaultMaterial("nolighting");
    sph.clear();
    qsys::AmbientProbeVolume::collectOccluderSpheres(pScene, sph);
    EXPECT_TRUE(sph.empty());

    const qlib::uid_t uid = pScene->getUID();
    pMol = molstr::MolCoordPtr();
    pCpk = qsys::RendererPtr();
    pScene = qsys::ScenePtr();
    qsys::SceneManager::getInstance()->destroyScene(uid);
}
