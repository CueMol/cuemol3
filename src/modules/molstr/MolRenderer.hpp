// -*-Mode: C++;-*-
//
//  Superclass of molecular renderers
//
//  $Id: MolRenderer.hpp,v 1.17 2011/02/14 14:36:59 rishitani Exp $

#ifndef MOL_RENDERER_HPP_
#define MOL_RENDERER_HPP_

#include "molstr.hpp"

#include <qlib/mcutils.hpp>
#include <qlib/Vector4D.hpp>

#include <qsys/DispListRenderer.hpp>
#include <gfx/SolidColor.hpp>

#include "ElemSym.hpp"
#include "Selection.hpp"
#include "MolCoord.hpp"
#include "ColoringScheme.hpp"

namespace molstr {

  using qlib::Vector4D;
  using gfx::DisplayContext;

  /**
     Abstract class for molecular renderers
  */
  class MOLSTR_API MolRenderer : public qsys::DispListRenderer, public ColSchmHolder
  {
    MC_SCRIPTABLE;

  private:
    typedef qsys::DispListRenderer super_t;
    
    SelectionPtr m_pSel;

    /// The atoms the selection matches, for collectOcclusionSpheres (see
    /// occlusionAtomIDs).
    mutable std::vector<int> m_occAids;
    mutable bool m_bOccAidsValid = false;
    mutable int m_nOccMolAtoms = -1;

  public:

    MolRenderer();
    MolRenderer(const MolRenderer &r);
    ~MolRenderer() override;

    //////////////////////////////////////////////////////
    // Renderer implementation

    qlib::Vector4D getCenter() const override;
    bool hasCenter() const override;

    bool isCompatibleObj(qsys::ObjectPtr pobj) const override;

    LString toString() const override;

    void propChanged(qlib::LPropEvent &ev) override;

    // check the MolCoord's coloring change
    void objectChanged(qsys::ObjectEvent &ev) override;

    LString interpHit(const gfx::RawHitData &rhit) override;

    /// Collect (atom_id, world_pos) for each hit atom, for polygon selection.
    void getHitPositions(const gfx::RawHitData &rhit,
                                 std::vector<int> &ids,
                                 std::vector<qlib::Vector4D> &poss) const override;

    //////////////////////////////////////////////////////
    // MolRenderer interface (selection)

    // Set selection object
    //  (copy of the selection object is retained)
    virtual void setSelection(SelectionPtr pSel);
    
    // Get selection object
    virtual SelectionPtr getSelection() const;

    //////////////////////////////////////////////////////
    // Final methods

    MolCoordPtr getClientMol() const;

    /// Occluder spheres for the ambient probes: the selected atoms with a
    /// nominal 1.8 A radius. The GPU probe bake draws the real geometry and
    /// uses these only for the grid bounds and change detection; renderers
    /// that draw atom spheres override with their radii.
    void collectOcclusionSpheres(std::vector<qlib::Vector4D> &out) const override;

  protected:
    /// IDs of the atoms the selection matches. Evaluating the selection over
    /// every atom is the costly part of collecting the occluders (~11 ms per
    /// renderer for 59k atoms), so the IDs are kept until the selection or the
    /// molecule's atoms change (a topology change, or a different atom count).
    /// Atoms moving keeps them: the coordinate-texture paths of the renderers
    /// likewise keep their selected atoms while atoms move.
    const std::vector<int> &occlusionAtomIDs() const;

  public:

    /// make hittestresult JSON string for atom aid
    static LString interpHitAidImpl(MolAtomPtr pAtom);

    static ColorPtr evalMolColor(ColorPtr pCol, ColorPtr pCol2);

  };

}

#endif
