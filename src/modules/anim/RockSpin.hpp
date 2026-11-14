// -*-Mode: C++;-*-
//
// RockSpin: oscillating spin animation object
//
// Swings the view about an axis around the orientation it had before the
// element (rock), optionally adding a secondary axis (view direction x axis)
// for a circle (nutate) or a figure 8 (wobble). The angles are offset by
// their value at rho=0, so the element always starts from the orientation it
// was given, without a jump.
//

#ifndef ANIM_ROCK_SPIN_HPP_INCLUDED
#define ANIM_ROCK_SPIN_HPP_INCLUDED

#include "anim.hpp"
#include <qlib/LScrVector4D.hpp>
#include <qlib/LQuat.hpp>
#include <qsys/qsys.hpp>
#include <qsys/anim/AnimObj.hpp>

namespace anim {

  using qlib::LReal;
  using qlib::LScrVector4D;
  using qlib::Vector4D;
  using qsys::AnimMgr;

  class ANIM_API RockSpin : public qsys::AnimObj
  {
    MC_SCRIPTABLE;
    MC_CLONEABLE;

  public:
    static constexpr int PAT_ROCK = 0;
    static constexpr int PAT_NUTATE = 1;
    static constexpr int PAT_WOBBLE = 2;

    static constexpr int ENV_NONE = 0;
    static constexpr int ENV_GROW = 1;
    static constexpr int ENV_SHRINK = 2;

  private:
    typedef qsys::AnimObj super_t;

    int m_nPattern;
    LReal m_angle;
    Vector4D m_axis;
    LReal m_cycles;
    LReal m_phase;
    LReal m_aspect;
    int m_nEnvelope;

  public:
    RockSpin();
    RockSpin(const RockSpin &arg);
    ~RockSpin() override;

    void onTimer(qlib::time_value elapsed, AnimMgr *pMgr) override;
    void onTimerPost(qlib::time_value elapsed, AnimMgr *pMgr) override;

    int getPattern() const { return m_nPattern; }
    void setPattern(int n) { m_nPattern = n; }

    LReal getAngle() const { return m_angle; }
    void setAngle(LReal val) { m_angle = val; }

    LScrVector4D getScrAxis() const { return m_axis; }
    void setScrAxis(const LScrVector4D &val) { setAxis(val); }
    Vector4D getAxis() const { return m_axis; }
    void setAxis(const Vector4D &val);

    LReal getCycles() const { return m_cycles; }
    void setCycles(LReal val) { m_cycles = val; }

    LReal getPhase() const { return m_phase; }
    void setPhase(LReal val) { m_phase = val; }

    LReal getAspect() const { return m_aspect; }
    void setAspect(LReal val) { m_aspect = val; }

    int getEnvelope() const { return m_nEnvelope; }
    void setEnvelope(int n) { m_nEnvelope = n; }

    /// Secondary axis: normalize(cross(view direction, axis)), or the zero
    /// vector when the axis is parallel to the view direction (no secondary
    /// rotation then).
    Vector4D getAxis2() const;

    /// Rotation angles (degrees) about the primary and the secondary axis at
    /// rho, already offset by their value at rho=0.
    void getAnglesAt(double rho, double &a1, double &a2) const;

  private:
    /// Raw angles g1(rho), g2(rho) before the rho=0 offset.
    void rawAngles(double rho, double &g1, double &g2) const;

    /// Apply the rotation at rho to the work camera.
    void applyAt(double rho, AnimMgr *pMgr) const;
  };
}

#endif
