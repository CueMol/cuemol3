// -*-Mode: C++;-*-
//
// MolRenderer::collectOcclusionSpheres keeps the atoms its selection matches
// between Fast GI probe bakes (evaluating the selection is the costly part).
// The kept atoms must follow selection and topology changes, and the spheres
// must follow moved atoms, or the probe grid misses part of what is drawn.
//

#include <gtest/gtest.h>
#include <common.h>

#include "molstr/MolAtom.hpp"
#include "molstr/MolCoord.hpp"
#include "molstr/MolRenderer.hpp"
#include "molstr/SelCommand.hpp"
#include <qsys/Scene.hpp>
#include <qsys/SceneManager.hpp>

#include <vector>

using molstr::MolAtom;
using molstr::MolAtomPtr;
using molstr::MolCoord;
using molstr::MolCoordPtr;
using molstr::ResidIndex;
using molstr::SelCommand;
using molstr::SelectionPtr;
using qlib::Vector4D;

namespace {

int addAtom(MolCoordPtr pMol, int resid, const char *name, const Vector4D &pos)
{
    MolAtomPtr pAtom(MB_NEW MolAtom());
    pAtom->setChainName("A");
    pAtom->setResName("ALA");
    pAtom->setResIndex(ResidIndex(resid));
    pAtom->setName(name);
    pAtom->setElementName("C");
    pAtom->setPos(pos);
    return pMol->appendAtom(pAtom);
}

}  // namespace

class OcclusionSpheresTest : public ::testing::Test
{
protected:
    qsys::ScenePtr m_pScene;
    MolCoordPtr m_pMol;
    molstr::MolRenderer *m_pRend = nullptr;

    void SetUp() override
    {
        m_pScene = qsys::SceneManager::getInstance()->createScene();
        m_pMol = MolCoordPtr(MB_NEW MolCoord());
        // Residues 1-3, atoms N and CA, along x.
        for (int r = 1; r <= 3; ++r) {
            addAtom(m_pMol, r, "N", Vector4D(10.0 * r, 0.0, 0.0));
            addAtom(m_pMol, r, "CA", Vector4D(10.0 * r, 1.0, 0.0));
        }
        m_pScene->addObject(m_pMol);
        qsys::RendererPtr pRend = m_pMol->createRenderer("simple");
        m_pRend = dynamic_cast<molstr::MolRenderer *>(pRend.get());
        ASSERT_NE(m_pRend, nullptr);
        m_pRend->setSelection(sel("resid 1:2"));
    }

    void TearDown() override
    {
        const qlib::uid_t uid = m_pScene->getUID();
        m_pMol = MolCoordPtr();
        m_pScene = qsys::ScenePtr();
        qsys::SceneManager::getInstance()->destroyScene(uid);
    }

    SelectionPtr sel(const char *expr)
    {
        SelCommand *pCom = MB_NEW SelCommand();
        SelectionPtr pSel(pCom);
        EXPECT_TRUE(pCom->compile(expr, m_pScene->getUID())) << expr;
        return pSel;
    }

    std::vector<Vector4D> spheres()
    {
        std::vector<Vector4D> out;
        m_pRend->collectOcclusionSpheres(out);
        return out;
    }

    static bool hasCenter(const std::vector<Vector4D> &sph, const Vector4D &c)
    {
        for (const auto &v : sph)
            if (v.x() == c.x() && v.y() == c.y() && v.z() == c.z()) return true;
        return false;
    }
};

TEST_F(OcclusionSpheresTest, FollowsMovedAtomsSelectionAndTopology)
{
    ASSERT_EQ(spheres().size(), 4u);

    // Moved atoms: the same atoms, at their new positions.
    MolAtomPtr pAtom = m_pMol->getAtom("A", ResidIndex(1), "N");
    pAtom->setPos(Vector4D(-5.0, 0.0, 0.0));
    m_pMol->fireAtomsMoved();
    std::vector<Vector4D> sph = spheres();
    EXPECT_EQ(sph.size(), 4u);
    EXPECT_TRUE(hasCenter(sph, Vector4D(-5.0, 0.0, 0.0)));

    // A new selection.
    m_pRend->setSelection(sel("resid 1:3"));
    EXPECT_EQ(spheres().size(), 6u);

    // An atom replaced by another (the atom count stays the same): only the
    // topology event tells the kept atoms are stale.
    m_pRend->setSelection(sel("resid 2"));
    ASSERT_EQ(spheres().size(), 2u);
    m_pMol->removeAtom(m_pMol->getAtom("A", ResidIndex(2), "CA")->getID());
    addAtom(m_pMol, 2, "CB", Vector4D(20.0, 2.0, 0.0));
    m_pMol->fireTopologyChanged();
    sph = spheres();
    EXPECT_EQ(sph.size(), 2u);
    EXPECT_TRUE(hasCenter(sph, Vector4D(20.0, 2.0, 0.0)));
}
