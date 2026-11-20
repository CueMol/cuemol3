// -*-Mode: C++;-*-
//
// PostProcGpuPrim implementation
//

#include <common.h>

#include "PostProcGpuPrim.hpp"
#include "ShaderObject.hpp"
#include "DisplayContext.hpp"
#include "RenderTarget.hpp"
#include "DataTexture.hpp"

#include <qlib/LTypes.hpp>

#include <algorithm>

using namespace gfx;

// static
AoConstants AoConstants::fromCamera(double camDist, double zoom, double slabDepth,
                                    double aspect, int bcx, int bcy, bool perspec)
{
    // Camera slab planes, matching GUIView::setUpProjMat's near/far derivation.
    if (slabDepth <= 0.1) slabDepth = 0.1;
    double slabNear = camDist - slabDepth / 2.0;
    if (slabNear < 0.1) slabNear = 0.1;
    const double slabFar = camDist + slabDepth;

    // makePersProjMat uses t = camDist / (zoom/2), so tanHalfFOVY = (zoom/2)/camDist
    // and the orthographic half-extents are width = zoom/2 (see makeOrthoProjMat).
    const double width = zoom / 2.0;

    AoConstants c;
    c.isOrtho = perspec ? 0 : 1;
    if (perspec) {
        // Perspective: hyperbolic window depth, XY unprojected by viewZ.
        c.depthLinearizeMul = float(slabFar * slabNear / (slabFar - slabNear));
        c.depthLinearizeAdd = float(slabFar / (slabFar - slabNear));
        const double tanHalfFovY = width / camDist;
        const double tanHalfFovX = tanHalfFovY * aspect;
        c.ndcToViewMul[0] = float(2.0 * tanHalfFovX);
        c.ndcToViewMul[1] = float(2.0 * tanHalfFovY);
        c.ndcToViewAdd[0] = float(-tanHalfFovX);
        c.ndcToViewAdd[1] = float(-tanHalfFovY);
    } else {
        // Orthographic: window depth is linear, viewZ = near + d*(far - near),
        // so store (near, far - near). XY is depth-independent and spans
        // makeOrthoProjMat's extents ([-width*aspect, width*aspect] x [-width, width]).
        c.depthLinearizeMul = float(slabNear);
        c.depthLinearizeAdd = float(slabFar - slabNear);
        c.ndcToViewMul[0] = float(2.0 * width * aspect);
        c.ndcToViewMul[1] = float(2.0 * width);
        c.ndcToViewAdd[0] = float(-width * aspect);
        c.ndcToViewAdd[1] = float(-width);
    }
    c.viewportPixelSize[0] = (bcx > 0) ? 1.0f / float(bcx) : 0.0f;
    c.viewportPixelSize[1] = (bcy > 0) ? 1.0f / float(bcy) : 0.0f;
    return c;
}

bool PostProcGpuPrim::init(DisplayContext *pDC)
{
    if (m_pPO != nullptr) return true;

    m_pPO = pDC->loadShaderObject("depthvis",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/depthvis_frag.glsl");
    if (m_pPO == nullptr) {
        LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load depthvis shader.");
        return false;
    }

    return ensureDrawElem(pDC);
}

bool PostProcGpuPrim::ensureDrawElem(DisplayContext *pDC)
{
    if (m_pDrawElem == nullptr) alloc(pDC);
    return m_pDrawElem != nullptr;
}

void PostProcGpuPrim::alloc(DisplayContext *pDC)
{
    MB_ASSERT(pDC != nullptr);

    m_pDrawElem = MB_NEW TriArray();
    TriArray &data = *m_pDrawElem;

    data.setAttrSize(1);
    data.setAttrInfo(0, ATTRLOC_VERTEX, 2, qlib::type_consts::QTC_FLOAT32,
                     offsetof(Elem, x));

    pDC->allocBuffer(data, 3, 0);
    data.setDrawMode(AbstDrawElem::DRAW_TRIANGLES);

    // Oversized triangle that covers the whole NDC viewport.
    data.at(0) = {-1.0f, -1.0f};
    data.at(1) = {3.0f, -1.0f};
    data.at(2) = {-1.0f, 3.0f};
}

void PostProcGpuPrim::drawDepthVis(DisplayContext *pDC, RenderTarget *prt,
                                   float vnear, float vfar)
{
    MB_ASSERT(m_pPO != nullptr);
    MB_ASSERT(m_pDrawElem != nullptr);
    if (prt == nullptr) return;

    prt->bindDepthTex(RT_TU_DEPTH);

    m_pPO->enable();
    m_pPO->setUniform("u_depthTex", RT_TU_DEPTH);
    m_pPO->setUniformF("u_near", vnear);
    m_pPO->setUniformF("u_far", vfar);

    pDC->drawElem(*m_pDrawElem);

    m_pPO->disable();

    prt->unbindTextures();
}

void PostProcGpuPrim::drawComposite(DisplayContext *pDC, RenderTarget *sceneRT,
                                    RenderTarget *aoRT, const AoConstants &consts,
                                    RenderTarget *bounceRT)
{
    if (sceneRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pCompPO == nullptr) {
        m_pCompPO =
            pDC->loadShaderObject("ao_composite",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/ao_composite_frag.glsl");
        if (m_pCompPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load ao_composite shader.");
            return;
        }
    }

    sceneRT->bindColorTex(0, RT_TU_COLOR);
    // Bitmask AO (aoMethod 1) darkens the ambient light only: the scene
    // normal target's .w carries the ambient fraction of each pixel.
    const bool ambientOnly =
        aoRT != nullptr && consts.aoMethod == 1 && sceneRT->hasNormal();
    if (aoRT != nullptr) {
        aoRT->bindColorTex(0, RT_TU_NORMAL);   // AO term on unit 2
        sceneRT->bindDepthTex(RT_TU_DEPTH);    // scene depth for the upsample
    }
    if (ambientOnly) sceneRT->bindColorTex(1, RT_TU_NOISE);  // normal + ambient fraction
    // Gathered indirect light (the AO pass target's second attachment).
    const bool hasBounce = ambientOnly && bounceRT != nullptr && bounceRT->hasNormal();
    if (hasBounce) bounceRT->bindColorTex(1, RT_TU_SMAA_AREA);

    m_pCompPO->enable();
    m_pCompPO->setUniform("u_colorTex", RT_TU_COLOR);
    m_pCompPO->setUniform("u_aoTex", RT_TU_NORMAL);
    // hasAO lets the shader fall back to a plain copy when no AO is supplied.
    m_pCompPO->setUniform("u_hasAO", (aoRT != nullptr) ? 1 : 0);
    m_pCompPO->setUniform("u_depthTex", RT_TU_DEPTH);
    m_pCompPO->setUniformF("u_depthUnpack", consts.depthLinearizeMul,
                           consts.depthLinearizeAdd);
    m_pCompPO->setUniformF("u_aoTexelSize", consts.aoTexelSize[0],
                           consts.aoTexelSize[1]);
    // Fog factor reconstruction: fade the AO term out where fog has taken over
    // so a fully-fogged (background-color) pixel is not darkened by AO.
    m_pCompPO->setUniformF("u_fogEnd", consts.fogEnd);
    m_pCompPO->setUniformF("u_fogScale", consts.fogScale);
    m_pCompPO->setUniformF("u_fogColor", consts.fogColor[0], consts.fogColor[1],
                           consts.fogColor[2]);
    m_pCompPO->setUniform("u_isOrtho", consts.isOrtho);
    // Upsample only when the AO buffer is coarser than the output (half res).
    const bool upsample = consts.aoTexelSize[0] > consts.viewportPixelSize[0] * 1.5f;
    m_pCompPO->setUniform("u_upsample", upsample ? 1 : 0);
    m_pCompPO->setUniform("u_debugView", consts.debugView);
    m_pCompPO->setUniform("u_ambientOnly", ambientOnly ? 1 : 0);
    m_pCompPO->setUniform("u_sceneNormalTex", RT_TU_NOISE);
    m_pCompPO->setUniform("u_bounceTex", RT_TU_SMAA_AREA);
    m_pCompPO->setUniform("u_specOcclusion", consts.specOcclusion ? 1 : 0);
    m_pCompPO->setUniformF("u_lightAmbient", consts.lightAmbient);
    m_pCompPO->setUniformF("u_lightDiffuse", consts.lightDiffuse);
    m_pCompPO->setUniformF("u_lightDir", consts.lightDir[0], consts.lightDir[1], consts.lightDir[2]);
    m_pCompPO->setUniform("u_keyShadow", (ambientOnly && consts.keyShadow) ? 1 : 0);
    m_pCompPO->setUniform("u_hasBounce", hasBounce ? 1 : 0);
    m_pCompPO->setUniformF("u_bounceScale",
                           hasBounce ? consts.bounceStrength / std::max(consts.lightAmbient, 1e-3f)
                                     : 0.0f);

    pDC->drawElem(*m_pDrawElem);

    m_pCompPO->disable();

    sceneRT->unbindTextures();
    if (aoRT != nullptr) aoRT->unbindTextures();
    if (hasBounce) bounceRT->unbindTextures();
}

void PostProcGpuPrim::drawProbeBake(DisplayContext *pDC, RenderTarget *depthAtlasRT,
                                    const ProbeBakeParams &bp)
{
    if (depthAtlasRT == nullptr || !ensureDrawElem(pDC)) return;
    if (m_pProbeBakePO == nullptr) {
        m_pProbeBakePO =
            pDC->loadShaderObject("probe_bake", "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/probe_bake_frag.glsl");
        if (m_pProbeBakePO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load probe_bake shader.");
            return;
        }
    }
    depthAtlasRT->bindDepthTex(RT_TU_DEPTH);
    m_pProbeBakePO->enable();
    m_pProbeBakePO->setUniform("u_depthAtlas", RT_TU_DEPTH);
    m_pProbeBakePO->setUniformF("u_center", bp.center[0], bp.center[1], bp.center[2]);
    m_pProbeBakePO->setUniformF("u_radius", bp.radius);
    m_pProbeBakePO->setUniformF("u_camDist", bp.camDist);
    m_pProbeBakePO->setUniformF("u_nearFar", bp.nearFar[0], bp.nearFar[1]);
    m_pProbeBakePO->setUniform("u_tileSize", bp.tileSize);
    m_pProbeBakePO->setUniform("u_tilesPerRow", bp.tilesPerRow);
    m_pProbeBakePO->setUniform("u_dim", bp.dim[0], bp.dim[1], bp.dim[2]);
    m_pProbeBakePO->setUniformF("u_origin", bp.origin[0], bp.origin[1], bp.origin[2]);
    m_pProbeBakePO->setUniformF("u_spacing", bp.spacing);
    m_pProbeBakePO->setUniformF("u_depthBias", bp.depthBias);
    m_pProbeBakePO->setUniform("u_numDirs", bp.numDirs);
    pDC->drawElem(*m_pDrawElem);
    m_pProbeBakePO->disable();
    depthAtlasRT->unbindTextures();
}

void PostProcGpuPrim::drawProbeFill(DisplayContext *pDC, RenderTarget *srcRT,
                                    const ProbeBakeParams &bp)
{
    if (srcRT == nullptr || !ensureDrawElem(pDC)) return;
    if (m_pProbeFillPO == nullptr) {
        m_pProbeFillPO =
            pDC->loadShaderObject("probe_fill", "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/probe_fill_frag.glsl");
        if (m_pProbeFillPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load probe_fill shader.");
            return;
        }
    }
    srcRT->bindColorTex(0, RT_TU_COLOR);
    m_pProbeFillPO->enable();
    m_pProbeFillPO->setUniform("u_src", RT_TU_COLOR);
    m_pProbeFillPO->setUniform("u_dim", bp.dim[0], bp.dim[1], bp.dim[2]);
    pDC->drawElem(*m_pDrawElem);
    m_pProbeFillPO->disable();
    srcRT->unbindTextures();
}

void PostProcGpuPrim::drawGtao(DisplayContext *pDC, RenderTarget *sceneRT,
                              const AoConstants &consts, int debugMode,
                              const AoProbeParams *probe)
{
    if (sceneRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pGtaoPO == nullptr) {
        m_pGtaoPO =
            pDC->loadShaderObject("gtao",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/gtao_frag.glsl");
        if (m_pGtaoPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load gtao shader.");
            return;
        }
    }

    sceneRT->bindDepthTex(RT_TU_DEPTH);

    // Use the MRT geometry normal when the scene target carries one; otherwise
    // the shader reconstructs the normal from depth (u_hasNormal == 0).
    const bool hasNormal = sceneRT->hasNormal();
    if (hasNormal) sceneRT->bindColorTex(1, RT_TU_NORMAL);

    m_pGtaoPO->enable();
    m_pGtaoPO->setUniform("u_depthTex", RT_TU_DEPTH);
    m_pGtaoPO->setUniform("u_normalTex", RT_TU_NORMAL);
    m_pGtaoPO->setUniform("u_hasNormal", hasNormal ? 1 : 0);
    m_pGtaoPO->setUniformF("u_depthUnpack", consts.depthLinearizeMul,
                           consts.depthLinearizeAdd);
    m_pGtaoPO->setUniformF("u_ndcToViewMul", consts.ndcToViewMul[0],
                           consts.ndcToViewMul[1]);
    m_pGtaoPO->setUniformF("u_ndcToViewAdd", consts.ndcToViewAdd[0],
                           consts.ndcToViewAdd[1]);
    m_pGtaoPO->setUniformF("u_viewportPixelSize", consts.viewportPixelSize[0],
                           consts.viewportPixelSize[1]);
    m_pGtaoPO->setUniformF("u_effectRadius", consts.effectRadius);
    m_pGtaoPO->setUniformF("u_finalValuePower", consts.finalValuePower);
    m_pGtaoPO->setUniform("u_sliceCount", consts.sliceCount);
    m_pGtaoPO->setUniform("u_stepCount", consts.stepsPerSlice);
    m_pGtaoPO->setUniform("u_debugMode", debugMode);
    m_pGtaoPO->setUniformF("u_aoNoiseOffset", consts.aoNoiseOffset);
    m_pGtaoPO->setUniformF("u_maxScreenspaceRadius", consts.maxScreenspaceRadius);
    m_pGtaoPO->setUniform("u_isOrtho", consts.isOrtho);
    m_pGtaoPO->setUniform("u_method", consts.aoMethod);
    const bool hasProbe = probe != nullptr && probe->atlas != nullptr;
    m_pGtaoPO->setUniform("u_hasProbe", hasProbe ? 1 : 0);
    // Its own unit, clear of the scene colour / depth / normal units.
    m_pGtaoPO->setUniform("u_probeAtlas", RT_TU_SMAA_SEARCH);
    if (hasProbe) {
        probe->atlas->bindColorTex(0, RT_TU_SMAA_SEARCH);
        m_pGtaoPO->setUniform("u_probeDim", probe->dim[0], probe->dim[1], probe->dim[2]);
        m_pGtaoPO->setUniformF("u_probeSpacing", probe->spacing);
        m_pGtaoPO->setMatrix("u_viewToWorld", probe->viewToWorld);
        m_pGtaoPO->setUniformF("u_probeOrigin", probe->origin[0], probe->origin[1],
                               probe->origin[2]);
        m_pGtaoPO->setUniformF("u_probeBias", probe->bias);
        m_pGtaoPO->setUniformF("u_probeStrength", probe->strength);
        m_pGtaoPO->setUniformF("u_lightDirEye", probe->lightDir[0], probe->lightDir[1],
                               probe->lightDir[2]);
    }
    m_pGtaoPO->setUniformF("u_keyShadow", hasProbe ? probe->keyShadow : 0.0f);
    m_pGtaoPO->setUniformF("u_keyShadowPower", hasProbe ? probe->keyShadowPower : 1.0f);
    m_pGtaoPO->setUniformF("u_fullPixelSize", consts.fullPixelSize[0], consts.fullPixelSize[1]);
    m_pGtaoPO->setUniformF("u_thicknessNear", consts.thicknessNear);
    // Near-field indirect light (bitmask): the lit scene colour is the
    // radiance of the occluders; the fog is taken out of it per sample.
    const bool bounce = consts.aoMethod == 1 && consts.bounceStrength > 0.0f;
    m_pGtaoPO->setUniform("u_bounce", bounce ? 1 : 0);
    m_pGtaoPO->setUniform("u_sceneColorTex", RT_TU_COLOR);
    if (bounce) {
        sceneRT->bindColorTex(0, RT_TU_COLOR);
        m_pGtaoPO->setUniformF("u_fogEnd", consts.fogEnd);
        m_pGtaoPO->setUniformF("u_fogScale", consts.fogScale);
        m_pGtaoPO->setUniformF("u_fogColor", consts.fogColor[0], consts.fogColor[1],
                               consts.fogColor[2]);
    }

    pDC->drawElem(*m_pDrawElem);

    m_pGtaoPO->disable();
    if (hasProbe) probe->atlas->unbindTextures();

    sceneRT->unbindTextures();
}

void PostProcGpuPrim::drawDenoise(DisplayContext *pDC, RenderTarget *aoRT,
                                 const AoConstants &consts)
{
    if (aoRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pDenoisePO == nullptr) {
        m_pDenoisePO =
            pDC->loadShaderObject("ao_denoise",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/ao_denoise_frag.glsl");
        if (m_pDenoisePO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load ao_denoise shader.");
            return;
        }
    }

    aoRT->bindColorTex(0, RT_TU_COLOR);

    m_pDenoisePO->enable();
    m_pDenoisePO->setUniform("u_aoTex", RT_TU_COLOR);
    m_pDenoisePO->setUniformF("u_viewportPixelSize", consts.viewportPixelSize[0],
                              consts.viewportPixelSize[1]);

    pDC->drawElem(*m_pDrawElem);

    m_pDenoisePO->disable();

    aoRT->unbindTextures();
}

void PostProcGpuPrim::drawFxaa(DisplayContext *pDC, RenderTarget *srcColorRT,
                              const AoConstants &consts)
{
    if (srcColorRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pFxaaPO == nullptr) {
        m_pFxaaPO =
            pDC->loadShaderObject("fxaa",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/fxaa_frag.glsl");
        if (m_pFxaaPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load fxaa shader.");
            return;
        }
    }

    srcColorRT->bindColorTex(0, RT_TU_COLOR);

    m_pFxaaPO->enable();
    m_pFxaaPO->setUniform("u_colorTex", RT_TU_COLOR);
    m_pFxaaPO->setUniformF("u_rcpFrame", consts.viewportPixelSize[0],
                           consts.viewportPixelSize[1]);

    pDC->drawElem(*m_pDrawElem);

    m_pFxaaPO->disable();

    srcColorRT->unbindTextures();
}

bool PostProcGpuPrim::ensureSmaaTextures(DisplayContext *pDC)
{
    if (m_pSmaaAreaTex != nullptr && m_pSmaaSearchTex != nullptr) return true;

    // AreaTex: 160x560 RG8 LINEAR. SearchTex: 66x33 R8 NEAREST. Decoded from
    // Mol*'s SMAA area/search PNGs (see docs / data/textures).
    if (m_pSmaaAreaTex == nullptr) {
        m_pSmaaAreaTex = pDC->createDataTextureFromFile(
            "%%CONFDIR%%/data/textures/smaa_area.dat", 160, 560, 2, true);
    }
    if (m_pSmaaSearchTex == nullptr) {
        m_pSmaaSearchTex = pDC->createDataTextureFromFile(
            "%%CONFDIR%%/data/textures/smaa_search.dat", 66, 33, 1, false);
    }
    if (m_pSmaaAreaTex == nullptr || m_pSmaaSearchTex == nullptr) {
        LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load SMAA lookup textures.");
        return false;
    }
    return true;
}

void PostProcGpuPrim::drawSmaaEdges(DisplayContext *pDC, RenderTarget *srcColorRT,
                                   const AoConstants &consts)
{
    if (srcColorRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pSmaaEdgePO == nullptr) {
        m_pSmaaEdgePO =
            pDC->loadShaderObject("smaa_edges",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/smaa_edges_frag.glsl");
        if (m_pSmaaEdgePO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load smaa_edges shader.");
            return;
        }
    }

    srcColorRT->bindColorTex(0, RT_TU_COLOR);

    m_pSmaaEdgePO->enable();
    m_pSmaaEdgePO->setUniform("u_colorTex", RT_TU_COLOR);
    m_pSmaaEdgePO->setUniformF("u_rcpFrame", consts.viewportPixelSize[0],
                               consts.viewportPixelSize[1]);
    m_pSmaaEdgePO->setUniformF("u_threshold", consts.smaaThreshold);

    pDC->drawElem(*m_pDrawElem);

    m_pSmaaEdgePO->disable();
    srcColorRT->unbindTextures();
}

void PostProcGpuPrim::drawSmaaWeights(DisplayContext *pDC, RenderTarget *edgesRT,
                                     const AoConstants &consts)
{
    if (edgesRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;
    if (!ensureSmaaTextures(pDC)) return;

    if (m_pSmaaWeightPO == nullptr) {
        m_pSmaaWeightPO =
            pDC->loadShaderObject("smaa_weights",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/smaa_weights_frag.glsl");
        if (m_pSmaaWeightPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load smaa_weights shader.");
            return;
        }
    }

    edgesRT->bindColorTex(0, RT_TU_COLOR);
    m_pSmaaAreaTex->bind(RT_TU_SMAA_AREA);
    m_pSmaaSearchTex->bind(RT_TU_SMAA_SEARCH);

    m_pSmaaWeightPO->enable();
    m_pSmaaWeightPO->setUniform("u_edgesTex", RT_TU_COLOR);
    m_pSmaaWeightPO->setUniform("u_areaTex", RT_TU_SMAA_AREA);
    m_pSmaaWeightPO->setUniform("u_searchTex", RT_TU_SMAA_SEARCH);
    m_pSmaaWeightPO->setUniformF("u_rcpFrame", consts.viewportPixelSize[0],
                                 consts.viewportPixelSize[1]);

    pDC->drawElem(*m_pDrawElem);

    m_pSmaaWeightPO->disable();
    edgesRT->unbindTextures();
}

void PostProcGpuPrim::drawSmaaBlend(DisplayContext *pDC, RenderTarget *srcColorRT,
                                   RenderTarget *weightsRT, const AoConstants &consts)
{
    if (srcColorRT == nullptr || weightsRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pSmaaBlendPO == nullptr) {
        m_pSmaaBlendPO =
            pDC->loadShaderObject("smaa_blend",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/smaa_blend_frag.glsl");
        if (m_pSmaaBlendPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load smaa_blend shader.");
            return;
        }
    }

    srcColorRT->bindColorTex(0, RT_TU_COLOR);
    weightsRT->bindColorTex(0, RT_TU_NORMAL);  // weights on unit 2

    m_pSmaaBlendPO->enable();
    m_pSmaaBlendPO->setUniform("u_colorTex", RT_TU_COLOR);
    m_pSmaaBlendPO->setUniform("u_weightsTex", RT_TU_NORMAL);
    m_pSmaaBlendPO->setUniformF("u_rcpFrame", consts.viewportPixelSize[0],
                                consts.viewportPixelSize[1]);

    pDC->drawElem(*m_pDrawElem);

    m_pSmaaBlendPO->disable();
    srcColorRT->unbindTextures();
    weightsRT->unbindTextures();
}

void PostProcGpuPrim::drawJitterCompose(DisplayContext *pDC, RenderTarget *srcRT,
                                       float weight)
{
    if (srcRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pJitterComposePO == nullptr) {
        m_pJitterComposePO =
            pDC->loadShaderObject("jitter_compose",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/jitter_compose_frag.glsl");
        if (m_pJitterComposePO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load jitter_compose shader.");
            return;
        }
    }

    srcRT->bindColorTex(0, RT_TU_COLOR);

    m_pJitterComposePO->enable();
    m_pJitterComposePO->setUniform("u_colorTex", RT_TU_COLOR);
    m_pJitterComposePO->setUniformF("u_weight", weight);

    pDC->drawElem(*m_pDrawElem);

    m_pJitterComposePO->disable();
    srcRT->unbindTextures();
}

void PostProcGpuPrim::drawHoverMask(DisplayContext *pDC, RenderTarget *pickRT,
                                    const int id[3], float sigma, int radius)
{
    if (pickRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pHoverMaskPO == nullptr) {
        m_pHoverMaskPO =
            pDC->loadShaderObject("hover_mask",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/hover_mask_frag.glsl");
        if (m_pHoverMaskPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load hover_mask shader.");
            return;
        }
    }

    // The integer pick texture is bound on its own unit (usampler2D); the IDs
    // are passed as ivec3 (the shader converts) since ShaderObject has no
    // unsigned setters.
    pickRT->bindColorTex(0, RT_TU_NOISE);

    m_pHoverMaskPO->enable();
    m_pHoverMaskPO->setUniform("u_pickTex", RT_TU_NOISE);
    m_pHoverMaskPO->setUniform("u_hlId", id[0], id[1], id[2]);
    m_pHoverMaskPO->setUniform("u_size", pickRT->getWidth(), pickRT->getHeight());
    m_pHoverMaskPO->setUniformF("u_sigma", sigma);
    m_pHoverMaskPO->setUniform("u_radius", radius);

    pDC->drawElem(*m_pDrawElem);

    m_pHoverMaskPO->disable();
    pickRT->unbindTextures();
}

void PostProcGpuPrim::drawHoverMaskBlur(DisplayContext *pDC, RenderTarget *maskRT,
                                        float sigma, int radius)
{
    if (maskRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pHoverBlurPO == nullptr) {
        m_pHoverBlurPO =
            pDC->loadShaderObject("hover_blur",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/hover_blur_frag.glsl");
        if (m_pHoverBlurPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load hover_blur shader.");
            return;
        }
    }

    maskRT->bindColorTex(0, RT_TU_COLOR);

    m_pHoverBlurPO->enable();
    m_pHoverBlurPO->setUniform("u_maskTex", RT_TU_COLOR);
    m_pHoverBlurPO->setUniform("u_size", maskRT->getWidth(), maskRT->getHeight());
    m_pHoverBlurPO->setUniformF("u_sigma", sigma);
    m_pHoverBlurPO->setUniform("u_radius", radius);

    pDC->drawElem(*m_pDrawElem);

    m_pHoverBlurPO->disable();
    maskRT->unbindTextures();
}

void PostProcGpuPrim::drawHoverHighlight(DisplayContext *pDC, RenderTarget *maskRT,
                                         const float fillRGBA[4],
                                         const float edgeInnerRGBA[4],
                                         const float edgeOuterRGBA[4])
{
    if (maskRT == nullptr) return;
    if (!ensureDrawElem(pDC)) return;

    if (m_pHoverPO == nullptr) {
        m_pHoverPO =
            pDC->loadShaderObject("hover_hl",
                                  "%%CONFDIR%%/data/shaders/postproc_vert.glsl",
                                  "%%CONFDIR%%/data/shaders/hover_hl_frag.glsl");
        if (m_pHoverPO == nullptr) {
            LOG_DPRINTLN("PostProcGpuPrim> ERROR: cannot load hover_hl shader.");
            return;
        }
    }

    maskRT->bindColorTex(0, RT_TU_COLOR);

    m_pHoverPO->enable();
    m_pHoverPO->setUniform("u_maskTex", RT_TU_COLOR);
    m_pHoverPO->setUniformF("u_fillColor", fillRGBA[0], fillRGBA[1], fillRGBA[2],
                            fillRGBA[3]);
    m_pHoverPO->setUniformF("u_edgeInner", edgeInnerRGBA[0], edgeInnerRGBA[1],
                            edgeInnerRGBA[2], edgeInnerRGBA[3]);
    m_pHoverPO->setUniformF("u_edgeOuter", edgeOuterRGBA[0], edgeOuterRGBA[1],
                            edgeOuterRGBA[2], edgeOuterRGBA[3]);

    pDC->drawElem(*m_pDrawElem);

    m_pHoverPO->disable();
    maskRT->unbindTextures();
}

void PostProcGpuPrim::invalidate()
{
    if (m_pDrawElem != nullptr) {
        delete m_pDrawElem;
        m_pDrawElem = nullptr;
    }
    // Shader programs are owned by the shader-object cache (loadShaderObject);
    // not deleted here.
    m_pPO = nullptr;
    m_pCompPO = nullptr;
    m_pGtaoPO = nullptr;
    m_pDenoisePO = nullptr;
    m_pProbeBakePO = nullptr;
    m_pProbeFillPO = nullptr;
    m_pHoverMaskPO = nullptr;
    m_pHoverBlurPO = nullptr;
    m_pHoverPO = nullptr;
    m_pFxaaPO = nullptr;
    m_pSmaaEdgePO = nullptr;
    m_pSmaaWeightPO = nullptr;
    m_pSmaaBlendPO = nullptr;
    m_pJitterComposePO = nullptr;

    // SMAA lookup textures are owned here (unlike the cached shader programs).
    if (m_pSmaaAreaTex != nullptr) {
        delete m_pSmaaAreaTex;
        m_pSmaaAreaTex = nullptr;
    }
    if (m_pSmaaSearchTex != nullptr) {
        delete m_pSmaaSearchTex;
        m_pSmaaSearchTex = nullptr;
    }
}
