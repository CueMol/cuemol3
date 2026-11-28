// -*-Mode: C++;-*-
//
// Scene::getMaterialLight: a renderer's material (data/default_style.xml)
// sets the light it is lit with, read as CueMol2's OpenGL view read it; a
// renderer without one takes the material "default".
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

    // No material is the material "default", "matte_plastic" is defined with
    // the same values, and a name no style defines gets them too.
    const double kSpec = 0.4 * Scene::kDefaultMaterialSpecular;
    const double kShin = Scene::kDefaultMaterialShininess;
    for (const char *name : {"", "default", "matte_plastic", "no_such_material"})
        expectLight(pScene->getMaterialLight(name), Scene::kLegacyLightAmbient,
                    Scene::kLegacyLightDiffuse, kSpec, kShin);
    // nolighting (ambient 1, diffuse 0, specular 0) shows its colour as
    // given, as POV-Ray and the ray tracer draw it: no global ambient on top,
    // and the brightness knob does not change it.
    expectLight(pScene->getMaterialLight("nolighting"), 1.0, 0.0, 0.0, 0.0);
    pScene->setLightBrightness(1.5);
    expectLight(pScene->getMaterialLight("nolighting"), 1.0, 0.0, 0.0, 0.0);
    pScene->setLightBrightness(1.0);

    // Fast GI scales the ambient and diffuse of every material so that
    // "default" gets its constants, and makes all three lights brighter by
    // kFastGILightBrightness; the exponent stays the material's.
    pScene->setAOEnabled(true);
    pScene->setAOMethod(Scene::AOM_FASTGI);
    const double kB = Scene::kFastGILightBrightness;
    expectLight(pScene->getMaterialLight(""), Scene::kFastGILightAmbient * kB,
                Scene::kFastGILightDiffuse * kB, kSpec * kB, kShin);
    // diff_metal: ambient 0.2, diffuse 0.5, specular 1.25, exponent 16, and
    // the metalness 0.6 from its <def> attribute (no toon bands, no rim).
    const Scene::MaterialLight metal = pScene->getMaterialLight("diff_metal");
    expectLight(metal, 0.4 * Scene::kFastGILightAmbient / Scene::kLegacyLightAmbient * kB,
                0.5 * Scene::kFastGILightDiffuse / Scene::kLegacyLightDiffuse * kB,
                0.4 * 1.25 * kB, 16.0);
    EXPECT_NEAR(metal.metallic, 0.6, 1e-5);
    EXPECT_EQ(metal.toon, 0.0f);
    EXPECT_EQ(metal.fresnel, 0.0f);
    // nolighting is lit by the ambient light alone and gets no AO, so Fast GI
    // keeps its light as without AO (no brightness boost either).
    expectLight(pScene->getMaterialLight("nolighting"), 1.0, 0.0, 0.0, 0.0);
    // A material without the attributes is not metallic.
    EXPECT_EQ(pScene->getMaterialLight("").metallic, 0.0f);
    // ceramic: the Fresnel rim strength 3 from its <def> attribute.
    EXPECT_NEAR(pScene->getMaterialLight("ceramic").fresnel, 3.0, 1e-5);

    // toon1 (POV-Ray: ambient 0, diffuse 0.8): with AO it keeps its flat
    // tones under the light any material gets, not its POV-Ray finish.
    const Scene::MaterialLight toonAO = pScene->getMaterialLight("toon1");
    expectLight(toonAO, 0.2 * Scene::kFastGILightAmbient / Scene::kLegacyLightAmbient * kB,
                0.8 * Scene::kFastGILightDiffuse / Scene::kLegacyLightDiffuse * kB, 0.0, 0.0);
    EXPECT_EQ(toonAO.toon, 1.0f);
    EXPECT_EQ(toonAO.toonPov, 0.0f);
    // GTAO keeps the light of no AO: neither the Fast GI balance nor its
    // brightness boost.
    pScene->setAOMethod(Scene::AOM_GTAO);
    expectLight(pScene->getMaterialLight(""), Scene::kLegacyLightAmbient,
                Scene::kLegacyLightDiffuse, kSpec, kShin);
    pScene->setAOMethod(Scene::AOM_FASTGI);

    // Without AO, as POV-Ray renders it: no global ambient, the diffuse
    // under kToonLightDiffuse.
    pScene->setAOEnabled(false);
    const Scene::MaterialLight toon = pScene->getMaterialLight("toon1");
    expectLight(toon, 0.0, 0.8 * Scene::kToonLightDiffuse, 0.0, 0.0);
    EXPECT_EQ(toon.toon, 1.0f);
    EXPECT_EQ(toon.toonPov, 1.0f);

    qsys::SceneManager::getInstance()->destroyScene(pScene->getUID());
}
