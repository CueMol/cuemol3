// -*-Mode: C++;-*-
//
// Scene::getMaterialLight: a renderer's material (data/default_style.xml)
// sets the light it is lit with, read as CueMol2's OpenGL view read it, and a
// renderer without one keeps the former light.
//

#include <gtest/gtest.h>
#include <common.h>

#include "qsys/Scene.hpp"
#include "qsys/SceneManager.hpp"
#include "qsys/style/StyleFile.hpp"

using qlib::LString;
using qsys::Scene;

namespace {

void expectLight(const Scene::MaterialLight &ml, double amb, double diff, double spec,
                 double shin)
{
    EXPECT_NEAR(ml.ambient, amb, 1e-5);
    EXPECT_NEAR(ml.diffuse, diff, 1e-5);
    EXPECT_NEAR(ml.specular, spec, 1e-5);
    EXPECT_NEAR(ml.shininess, shin, 1e-4);
}

}  // namespace

TEST(SceneMaterialLight, MaterialSetsTheLight)
{
    qsys::ScenePtr pScene = qsys::SceneManager::getInstance()->createScene();
    qsys::StyleFile sfile;
    sfile.loadFile(LString(CUEMOL2_DATA_DIR) + "/default_style.xml", pScene->getUID());
    pScene->setAOEnabled(false);

    // No material, or a name no style defines: the former light.
    expectLight(pScene->getMaterialLight(""), Scene::kLegacyLightAmbient,
                Scene::kLegacyLightDiffuse, Scene::kLegacyLightSpecular,
                Scene::kLegacyLightShininess);
    expectLight(pScene->getMaterialLight("no_such_material"), Scene::kLegacyLightAmbient,
                Scene::kLegacyLightDiffuse, Scene::kLegacyLightSpecular,
                Scene::kLegacyLightShininess);
    // nolighting (ambient 1, diffuse 0, specular 0): the global ambient 0.2 on
    // top, as in CueMol2.
    expectLight(pScene->getMaterialLight("nolighting"), 1.2, 0.0, 0.0, 0.0);

    // Fast GI scales every material so that no material gets its constants.
    pScene->setAOEnabled(true);
    pScene->setAOMethod(Scene::AOM_FASTGI);
    expectLight(pScene->getMaterialLight(""), Scene::kFastGILightAmbient,
                Scene::kFastGILightDiffuse, Scene::kFastGILightSpecular,
                Scene::kFastGILightShininess);

    qsys::SceneManager::getInstance()->destroyScene(pScene->getUID());
}
