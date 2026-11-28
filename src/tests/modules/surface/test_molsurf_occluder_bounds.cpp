// -*-Mode: C++;-*-
//
// MolSurfRenderer::collectOccluderBounds: the Fast GI probe bake bounds follow
// the faces the last render() drew (not the vertices it kept), only in fill
// mode (a wireframe or dot surface is unlit and occludes nothing).
//

#include "atom_color_test_util.hpp"

#include "molstr/SelCommand.hpp"
#include "surface/MolSurfObj.hpp"
#include "surface/MolSurfRenderer.hpp"

using namespace atomcoltest;

TEST_F(SceneFixture, MolSurfOccluderBoundsFollowDrawnFaces)
{
    // One triangle: vertex 0 is nearest to atom C0, vertices 1 and 2 to C1.
    surface::MolSurfObjPtr pSurf(MB_NEW surface::MolSurfObj());
    const Vector4D n(0.0, 0.0, 1.0);
    pSurf->setVertSize(3);
    pSurf->setVertex(0, Vector4D(0.0, 2.0, 2.0), n);
    pSurf->setVertex(1, Vector4D(4.0, 2.0, 2.0), n);
    pSurf->setVertex(2, Vector4D(4.0, 3.0, 2.0), n);
    pSurf->setFaceSize(1);
    pSurf->setFace(0, 0, 1, 2);
    pSurf->setName("surf");
    m_pScene->addObject(pSurf);
    qsys::RendererPtr pRend = pSurf->createRenderer("molsurf");
    auto *pMSR = dynamic_cast<surface::MolSurfRenderer *>(pRend.get());
    ASSERT_NE(pMSR, nullptr);
    pMSR->setTgtObjName("mol");

    auto boundsAfterRender = [pMSR]() {
        RecordDC dc(true);
        pMSR->render(&dc);
        std::vector<Vector4D> out;
        pMSR->collectOccluderBounds(out);
        return out;
    };

    // The drawn triangle: its box as 8 radius-0 corners.
    std::vector<Vector4D> out = boundsAfterRender();
    ASSERT_EQ(out.size(), 8u);
    Vector4D lo(1e30, 1e30, 1e30), hi(-1e30, -1e30, -1e30);
    for (const auto &v : out) {
        EXPECT_EQ(v.w(), 0.0);
        for (int a = 1; a <= 3; ++a) {
            lo.ai(a) = std::min(lo.ai(a), v.ai(a));
            hi.ai(a) = std::max(hi.ai(a), v.ai(a));
        }
    }
    EXPECT_NEAR(lo.x(), 0.0, 1e-6);
    EXPECT_NEAR(hi.x(), 4.0, 1e-6);
    EXPECT_NEAR(lo.y(), 2.0, 1e-6);
    EXPECT_NEAR(hi.y(), 3.0, 1e-6);

    // showsel keeps vertex 0 only: the face is dropped, so no bounds remain
    // although a vertex was kept.
    pMSR->setShowSel(molstr::SelectionPtr(MB_NEW molstr::SelCommand("name C0")));
    EXPECT_TRUE(boundsAfterRender().empty());

    // A wireframe surface occludes nothing.
    pMSR->setShowSel(molstr::SelectionPtr(MB_NEW molstr::SelCommand("*")));
    ASSERT_EQ(boundsAfterRender().size(), 8u);
    pMSR->setDrawMode(surface::MolSurfRenderer::SFDRAW_LINE);
    EXPECT_TRUE(boundsAfterRender().empty());
}
