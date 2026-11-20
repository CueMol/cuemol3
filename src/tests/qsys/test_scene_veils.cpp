// -*-Mode: C++;-*-
//
// Scene::assignVeils: renderer alphas grouped into the veils the frame
// pipeline composites (as the ray tracer's bucketVeils groups them).
//

#include <gtest/gtest.h>

#include "qsys/Scene.hpp"

#include <vector>

using qsys::Scene;

// Opaque alphas stay in the background; alphas within kVeilAlphaEps of a
// veil's join it, in order of first appearance.
TEST(SceneVeils, AlphasGroupIntoVeilsByFirstAppearance)
{
    const double eps = Scene::kVeilAlphaEps;
    const std::vector<double> alphas = {1.0, 0.5, 0.3, 0.5 + eps / 2, 1.0 - eps / 2, 0.3};
    std::vector<int> idx;
    std::vector<double> veils;
    Scene::assignVeils(alphas, idx, veils);

    EXPECT_EQ(idx, (std::vector<int>{-1, 0, 1, 0, -1, 1}));
    ASSERT_EQ(veils.size(), 2u);
    EXPECT_DOUBLE_EQ(veils[0], 0.5);
    EXPECT_DOUBLE_EQ(veils[1], 0.3);
}
