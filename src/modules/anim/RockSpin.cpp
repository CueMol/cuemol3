// -*-Mode: C++;-*-
//
// Oscillating spin animation
//

#include <common.h>

#include "RockSpin.hpp"
#include <qsys/anim/AnimMgr.hpp>
#include <qsys/Camera.hpp>

using namespace anim;
using qsys::CameraPtr;

RockSpin::RockSpin()
     : super_t(), m_nPattern(PAT_ROCK), m_angle(30.0), m_axis(0,1,0),
       m_cycles(1.0), m_phase(0.0), m_aspect(1.0), m_nEnvelope(ENV_NONE)
{
}

RockSpin::RockSpin(const RockSpin &arg)
     : super_t(arg), m_nPattern(arg.m_nPattern), m_angle(arg.m_angle),
       m_axis(arg.m_axis), m_cycles(arg.m_cycles), m_phase(arg.m_phase),
       m_aspect(arg.m_aspect), m_nEnvelope(arg.m_nEnvelope)
{
}

RockSpin::~RockSpin()
{
}

void RockSpin::setAxis(const Vector4D &val)
{
  double len = val.length();
  if (qlib::isNear4(len, 0.0)) {
    LOG_DPRINTLN("RockSpin> ERROR: axis length is too small!!");
    return;
  }
  m_axis = val.divide(len);
}

Vector4D RockSpin::getAxis2() const
{
  // view direction in screen coordinates is -z
  const Vector4D vdir(0, 0, -1);
  Vector4D a2 = vdir.cross(m_axis);
  const double len = a2.length();
  if (len < 1.0e-6)
    return Vector4D(0, 0, 0);
  return a2.divide(len);
}

void RockSpin::rawAngles(double rho, double &g1, double &g2) const
{
  double env = 1.0;
  if (m_nEnvelope == ENV_GROW)
    env = rho;
  else if (m_nEnvelope == ENV_SHRINK)
    env = 1.0 - rho;

  const double t = 2.0 * M_PI * m_cycles * rho + qlib::toRadian(m_phase);
  const double amp = env * m_angle * 0.5;
  g1 = amp * ::sin(t);

  g2 = 0.0;
  if (m_nPattern == PAT_NUTATE)
    g2 = amp * m_aspect * ::sin(t + M_PI * 0.5);
  else if (m_nPattern == PAT_WOBBLE)
    g2 = amp * m_aspect * ::sin(2.0 * t);
}

void RockSpin::getAnglesAt(double rho, double &a1, double &a2) const
{
  double g1, g2, z1, z2;
  rawAngles(rho, g1, g2);
  rawAngles(0.0, z1, z2);
  a1 = g1 - z1;
  a2 = g2 - z2;
  if (getAxis2().isZero3D())
    a2 = 0.0;
}

void RockSpin::applyAt(double rho, AnimMgr *pMgr) const
{
  double a1, a2;
  getAnglesAt(rho, a1, a2);

  CameraPtr pCam = pMgr->getWorkCam();
  pCam->m_rotQuat = pCam->m_rotQuat * qlib::LQuat(m_axis, qlib::toRadian(a1) * 0.5);
  if (a2 != 0.0)
    pCam->m_rotQuat = pCam->m_rotQuat * qlib::LQuat(getAxis2(), qlib::toRadian(a2) * 0.5);
}

void RockSpin::onTimer(qlib::time_value elapsed, AnimMgr *pMgr)
{
  applyAt(getRho(elapsed), pMgr);
}

void RockSpin::onTimerPost(qlib::time_value elapsed, AnimMgr *pMgr)
{
  applyAt(1.0, pMgr);
}
