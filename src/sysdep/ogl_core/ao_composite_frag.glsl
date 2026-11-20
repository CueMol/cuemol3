// AO composite fragment shader.
// Multiplies the off-screen scene color by the ambient-occlusion term and
// writes the result to the bound framebuffer. With u_hasAO == 0 it is a plain
// pass-through copy (used before the AO term is available).
//
// When the AO term is computed at a lower resolution than the output (half-res
// AO, u_upsample != 0), it is joint-bilateral upsampled: the four nearest AO
// texels are weighted by both their bilinear coverage and their depth
// similarity to the full-res pixel, so the AO does not bleed across silhouettes
// (no halo around objects).

uniform sampler2D u_colorTex;
uniform sampler2D u_aoTex;       // AO term in R (half or full resolution)
uniform sampler2D u_depthTex;    // full-res scene depth
uniform vec2 u_depthUnpack;      // (depthLinearizeMul, depthLinearizeAdd)
uniform vec2 u_aoTexelSize;      // (1/aoWidth, 1/aoHeight)
uniform int u_hasAO;
uniform int u_upsample;          // 1 = edge-aware upsample the AO term
uniform float u_fogEnd;          // linear fog far limit (view-space Z)
uniform float u_fogScale;        // 1/(fogEnd - fogStart)
uniform vec3 u_fogColor;         // fog colour (= background)
uniform int u_isOrtho;           // 1 = orthographic projection, 0 = perspective
uniform int u_debugView;         // 0 = color * AO, 1 = AO in gray, 2 = AO buffer RGB
// 1 = apply the AO to the ambient light only (Blender EEVEE): the scene normal
// target's length is 2 - f, f = the ambient fraction of the lit colour, and the
// colour becomes c * (1 - f * (1 - ao)). The scene colour may exceed 1 (HDR target);
// the output is clamped here.
uniform int u_ambientOnly;
uniform sampler2D u_sceneNormalTex;
// Bitmask: gathered near-field indirect irradiance (RGB, AO resolution) and
// bounceStrength / lightAmbient (the albedo is the ambient part / ambient).
// Specular occlusion (1 = on): the highlight of the lit colour is darkened by
// the AO too, with the Frostbite / legacy-EEVEE approximation. u_lightAmbient /
// u_lightDiffuse split the non-ambient part into diffuse and specular.
uniform int u_specOcclusion;
uniform float u_lightAmbient;
uniform float u_lightDiffuse;
uniform vec3 u_lightDir;  // eye-space direction to the light (not normalized)
uniform int u_keyShadow;   // 1 = the AO buffer's B is the key-light visibility
uniform int u_hasBounce;
uniform sampler2D u_bounceTex;
uniform float u_bounceScale;

in vec2 v_uv;

out vec4 o_FragColor;

float linearizeZ(float d)
{
    // Must match gtao_frag.glsl: orthographic depth is linear in viewZ,
    // perspective is hyperbolic.
    if (u_isOrtho != 0)
        return u_depthUnpack.x + d * u_depthUnpack.y;
    return u_depthUnpack.x / (u_depthUnpack.y - d);
}

// Nearest-depth upsample of the half-res AO term at uv (NVIDIA-style). On a
// flat surface the four AO taps have nearly equal depth and are blended
// smoothly (bilinear); across a silhouette the depth spread is large, so the
// AO of the single tap nearest the full-res depth is taken verbatim. Never
// mixing taps from across a depth step is what prevents the bright AO halo a
// soft bilateral weight leaves around edges.
float upsampleAO(vec2 uv)
{
    float zC = linearizeZ(texture(u_depthTex, uv).r);

    // Bilinear footprint of uv over the AO texel grid (taps 00,10,01,11).
    vec2 t = uv / u_aoTexelSize - 0.5;
    vec2 base = floor(t);
    vec2 frac = t - base;
    vec2 b = (base + 0.5) * u_aoTexelSize;
    vec2 px = vec2(u_aoTexelSize.x, 0.0);
    vec2 py = vec2(0.0, u_aoTexelSize.y);

    vec2 uv00 = b;
    vec2 uv10 = b + px;
    vec2 uv01 = b + py;
    vec2 uv11 = b + px + py;

    float a00 = texture(u_aoTex, uv00).r;
    float a10 = texture(u_aoTex, uv10).r;
    float a01 = texture(u_aoTex, uv01).r;
    float a11 = texture(u_aoTex, uv11).r;

    float z00 = linearizeZ(texture(u_depthTex, uv00).r);
    float z10 = linearizeZ(texture(u_depthTex, uv10).r);
    float z01 = linearizeZ(texture(u_depthTex, uv01).r);
    float z11 = linearizeZ(texture(u_depthTex, uv11).r);

    float w00 = (1.0 - frac.x) * (1.0 - frac.y);
    float w10 = frac.x * (1.0 - frac.y);
    float w01 = (1.0 - frac.x) * frac.y;
    float w11 = frac.x * frac.y;

    // Edge test: depth spread across the four taps relative to the centre depth.
    float zmin = min(min(z00, z10), min(z01, z11));
    float zmax = max(max(z00, z10), max(z01, z11));
    float threshold = max(abs(zC), 1e-4) * 0.03;

    if (zmax - zmin <= threshold) {
        // Flat region: smooth bilinear blend.
        return a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
    }

    // Silhouette: take the AO of the tap closest in depth (no cross-edge mix).
    float ao = a00;
    float best = abs(z00 - zC);
    float d;
    d = abs(z10 - zC); if (d < best) { best = d; ao = a10; }
    d = abs(z01 - zC); if (d < best) { best = d; ao = a01; }
    d = abs(z11 - zC); if (d < best) { best = d; ao = a11; }
    return ao;
}

void main()
{
    vec4 c = texture(u_colorTex, v_uv);
    if (u_hasAO != 0 && u_debugView == 2) {
        // The GTAO pass wrote its normal / depth debug image (not denoised).
        o_FragColor = vec4(texture(u_aoTex, v_uv).rgb, 1.0);
        return;
    }
    if (u_hasAO != 0) {
        float ao = (u_upsample != 0) ? upsampleAO(v_uv)
                                     : texture(u_aoTex, v_uv).r;
        // Fade AO out where fog has taken over: the scene color is already fog-
        // blended toward the background color, so a fully-fogged pixel must not
        // be darkened by AO (otherwise its shadow shows through the fog). fogVis
        // matches the scene's linear fog factor (fog_inc.glsl): 1 = near/clear,
        // 0 = far/fully fogged.
        float zlin = linearizeZ(texture(u_depthTex, v_uv).r);
        float fogVis = clamp((u_fogEnd - zlin) * u_fogScale, 0.0, 1.0);
        if (u_debugView == 1) {
            // Debug: the AO term alone (background stays white = unoccluded).
            o_FragColor = vec4(vec3(mix(1.0, ao, fogVis)), 1.0);
            return;
        }
        if (u_ambientOnly != 0) {
            // As in Blender / ChimeraX the fog (depth cue) comes after the
            // lighting: take the fog out, darken the ambient part of the lit
            // colour by the AO, and put the fog back. c = mix(fog, lit, fogVis),
            // so the lit part still in c is c - (1 - fogVis) * fog, and the
            // result is c - that * f * (1 - ao). Fogged pixels keep their
            // shading in proportion instead of losing it.
            float f = clamp(2.0 - length(texture(u_sceneNormalTex, v_uv).xyz), 0.0, 1.0);
            vec3 litPart = c.rgb - (1.0 - fogVis) * u_fogColor;
            vec3 outc = c.rgb - litPart * (f * (1.0 - ao));
            if ((u_specOcclusion != 0 || u_keyShadow != 0) && f < 0.999) {
                // The highlight still in the lit part: the non-ambient part minus
                // the diffuse part (albedo * diffuse * N.L, the light of
                // lighting_inc.glsl directionalLight2). Exact when diffuse is 0.
                vec3 nE = normalize(texture(u_sceneNormalTex, v_uv).xyz);
                float nDotL = max(dot(nE, normalize(u_lightDir)), 0.0);
                vec3 albedoAmb = litPart * f;  // albedo * ambient (fog-attenuated)
                vec3 diff = albedoAmb * (u_lightDiffuse / max(u_lightAmbient, 1e-3)) * nDotL;
                vec3 spec = max(litPart * (1.0 - f) - diff, vec3(0.0));
                // Lagarde & de Rousiers 2014 (Moving Frostbite to PBR), also the
                // legacy EEVEE specular_occlusion: so = saturate(pow(NV + ao,
                // exp2(-16 r - 1)) - 1 + ao), r = the Blinn-Phong exponent 16
                // (Scene::kFastGILightShininess) as GGX alpha sqrt(2 / (16 + 2)).
                // The view vector is taken as the eye axis.
                float nDotV = max(nE.z, 0.0);
                const float rough = 0.3333;
                float so = 1.0;
                if (u_specOcclusion != 0)
                    so = clamp(pow(nDotV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
                // Key-light shadow from the baked probes: occludes the direct
                // diffuse only. The probe shadow is too smooth for the
                // highlight (it dims the highlights of exposed atoms too); the
                // specular occlusion above already removes it in the cavities.
                float sh = (u_keyShadow != 0) ? texture(u_aoTex, v_uv).b : 1.0;
                outc -= diff * (1.0 - sh) + spec * (1.0 - so);
            }
            if (u_hasBounce != 0) {
                // Indirect diffuse: albedo * E, with albedo * ambient = the
                // ambient part (litPart * f, fog-attenuated like litPart).
                vec3 e = texture(u_bounceTex, v_uv).rgb;
                outc += litPart * f * u_bounceScale * e;
            }
            o_FragColor = clamp(vec4(outc, c.a), 0.0, 1.0);
            return;
        }
        ao = mix(1.0, ao, fogVis);
        o_FragColor = clamp(vec4(c.rgb * ao, c.a), 0.0, 1.0);
    } else {
        o_FragColor = c;
    }
}
