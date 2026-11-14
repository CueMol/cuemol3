#include <gtest/gtest.h>
#include <common.h>

#include "anim/RockSpin.hpp"

using anim::RockSpin;

// The swing angles RockSpin applies: rock is one sin on the primary axis,
// nutate / wobble add the secondary axis, every pattern starts from the
// given orientation (no jump at rho=0), and an axis along the view has no
// secondary axis.
TEST(RockSpin, AnglesFollowThePatternAndStartWithoutAJump)
{
    double a1 = 0, a2 = 0;

    RockSpin rock;  // rock, 30 deg, 1 cycle, axis y
    rock.getAnglesAt(0.25, a1, a2);
    EXPECT_NEAR(a1, 15.0, 1e-9);
    EXPECT_NEAR(a2, 0.0, 1e-9);

    RockSpin wobble;
    wobble.setPattern(RockSpin::PAT_WOBBLE);
    wobble.setAspect(0.3);
    // The secondary axis runs at twice the frequency: its peak is at 1/8.
    wobble.getAnglesAt(0.125, a1, a2);
    EXPECT_NEAR(a2, 15.0 * 0.3, 1e-9);
    EXPECT_NEAR(wobble.getAxis2().x(), 1.0, 1e-9);

    RockSpin nutate;
    nutate.setPattern(RockSpin::PAT_NUTATE);
    nutate.setAxis(qlib::Vector4D(1, 0, 0));
    // The raw secondary angle is +15 at rho=0; the offset removes it.
    nutate.getAnglesAt(0.0, a1, a2);
    EXPECT_NEAR(a1, 0.0, 1e-9);
    EXPECT_NEAR(a2, 0.0, 1e-9);
    nutate.getAnglesAt(0.25, a1, a2);
    EXPECT_NEAR(a1, 15.0, 1e-9);
    EXPECT_NEAR(a2, -15.0, 1e-9);
    // No envelope and a whole number of cycles: back where it started.
    nutate.getAnglesAt(1.0, a1, a2);
    EXPECT_NEAR(a1, 0.0, 1e-9);
    EXPECT_NEAR(a2, 0.0, 1e-9);

    RockSpin alongView;
    alongView.setPattern(RockSpin::PAT_WOBBLE);
    alongView.setAxis(qlib::Vector4D(0, 0, 1));
    EXPECT_TRUE(alongView.getAxis2().isZero3D());
    alongView.getAnglesAt(0.125, a1, a2);
    EXPECT_EQ(a2, 0.0);
}
