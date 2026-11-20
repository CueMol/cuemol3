// GTAO fragment shader (Ground-Truth Ambient Occlusion).
//
// Depth-only port of the XeGTAO main pass (Jimenez et al. 2016, "Practical
// Realtime Strategies for Accurate Indirect Occlusion"; Intel XeGTAO, MIT).
// Reads the scene depth texture, reconstructs view-space position and a
// depth-derived normal, and integrates horizon-based occlusion over a few
// slices. No depth MIP chain, no edges/denoise, no bent normals yet.
//
// View-space constants are derived CPU-side from the projection matrix:
//   viewZ      = u_depthUnpack.x / (u_depthUnpack.y - rawDepth)
//   viewPos.xy = (u_ndcToViewMul * uv + u_ndcToViewAdd) * viewZ
// with viewZ a positive linear distance and a GL bottom-up [0,1] UV.

uniform sampler2D u_depthTex;
uniform sampler2D u_normalTex;          // MRT eye-space normal (when u_hasNormal)
uniform vec2 u_depthUnpack;             // (depthLinearizeMul, depthLinearizeAdd)
uniform vec2 u_ndcToViewMul;
uniform vec2 u_ndcToViewAdd;
uniform vec2 u_viewportPixelSize;       // (1/width, 1/height)
uniform float u_effectRadius;           // occlusion sphere radius (view units)
uniform float u_finalValuePower;        // occlusion = pow(occlusion, power)
uniform int u_sliceCount;               // number of horizon slices (quality)
uniform int u_stepCount;                // number of steps marched per slice
uniform int u_hasNormal;                // 1 = use the stored geometry normal
uniform int u_debugMode;                // 0 = AO, 1 = normal, 2 = linear depth
uniform float u_aoNoiseOffset;          // per-sample noise rotation (temporal SS)
uniform float u_maxScreenspaceRadius;   // horizon search radius cap (pass pixels)
uniform int u_isOrtho;                  // 1 = orthographic projection, 0 = perspective
uniform int u_method;                   // 0 = GTAO, 1 = Fast GI (visibility bitmask)
uniform float u_thicknessNear;          // bitmask: constant minimum thickness (view units)
uniform vec2 u_fullPixelSize;          // (1/width, 1/height) of the full-res output
// Bitmask: baked world-space ambient probes (qsys::AmbientProbeVolume), the
// occlusion of the large cavities. RGBA = (m0, m1.xyz): mean
// visibility and mean visibility-weighted direction over the sphere.
// The probe grid is a 2D atlas, z slices side by side (x + z * nx, y).
uniform int u_hasProbe;                 // 1 = probes bound
uniform sampler2D u_probeAtlas;
uniform ivec3 u_probeDim;
uniform float u_probeSpacing;
uniform mat4 u_viewToWorld;             // GTAO view space -> world
uniform vec3 u_probeOrigin;
uniform float u_probeBias;              // lookup offset along the normal
uniform float u_probeStrength;          // probe visibility = mix(1, probe, strength)
uniform vec3 u_lightDirEye;             // eye-space direction to the key light
uniform float u_keyShadow;              // key-light shadow strength (0 = off)
uniform float u_keyShadowPower;         // contrast of the key-light shadow

// Bitmask: near-field indirect diffuse light (the colour that neighbouring
// surfaces reflect into a cavity).
// The lit scene colour (fog included) is the radiance of the occluders.
uniform int u_bounce;                   // 1 = gather into o_Bounce
uniform sampler2D u_sceneColorTex;
uniform float u_fogEnd;                 // linear fog of the scene colour
uniform float u_fogScale;
uniform vec3 u_fogColor;

in vec2 v_uv;

layout(location = 0) out vec4 o_FragColor;
// Gathered indirect irradiance (RGB, the AO pass target's second attachment;
// ignored when the target has none).
layout(location = 1) out vec4 o_Bounce;

const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;

float linearizeZ(float d)
{
    // Orthographic window depth is linear in viewZ (near + d * (far - near));
    // perspective is hyperbolic (mul / (add - d)).
    if (u_isOrtho != 0)
        return u_depthUnpack.x + d * u_depthUnpack.y;
    return u_depthUnpack.x / (u_depthUnpack.y - d);
}

vec3 viewPos(vec2 uv, float vz)
{
    // Perspective unprojects the in-plane coords by viewZ; orthographic XY is
    // depth-independent.
    vec2 xy = u_ndcToViewMul * uv + u_ndcToViewAdd;
    if (u_isOrtho == 0) xy *= vz;
    return vec3(xy, vz);
}

// View vector (fragment -> camera). Perspective rays diverge from the eye at the
// origin; orthographic rays are all parallel to the view axis (-Z here, since
// viewZ > 0 is forward).
vec3 camDir(vec3 p)
{
    return (u_isOrtho != 0) ? vec3(0.0, 0.0, -1.0) : normalize(-p);
}

// Per-pixel interleaved gradient noise in [0,1). Spectrally blue-ish, so the
// spatial denoise removes the residual grain well; with a high slice count its
// per-pixel structure is averaged out and not visible as a regular pattern.
float ign(vec2 p)
{
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// Depth-discontinuity edges (1 = flat, 0 = strong edge), per XeGTAO. The
// denoise pass reads these to avoid blurring AO across silhouettes.
vec4 calculateEdges(float cZ, float lZ, float rZ, float tZ, float bZ)
{
    vec4 e = vec4(lZ, rZ, tZ, bZ) - cZ;
    float slopeLR = (e.y - e.x) * 0.5;
    float slopeTB = (e.w - e.z) * 0.5;
    vec4 eAdj = e + vec4(slopeLR, -slopeLR, slopeTB, -slopeTB);
    e = min(abs(e), abs(eAdj));
    return clamp(1.25 - e / (cZ * 0.011), 0.0, 1.0);
}

// Pack the 4 edge values (2 bits each) into one 8-bit channel.
float packEdges(vec4 e)
{
    e = round(clamp(e, 0.0, 1.0) * 2.9);
    return dot(e, vec4(64.0 / 255.0, 16.0 / 255.0, 4.0 / 255.0, 1.0 / 255.0));
}

// Reconstruct the view-space normal from the closer horizontal / vertical
// neighbours, oriented toward the camera (all visible fragments are front
// facing).
vec3 reconstructNormal(vec2 uv, vec3 pC)
{
    vec2 e = u_viewportPixelSize;
    vec3 pR = viewPos(uv + vec2(e.x, 0.0), linearizeZ(texture(u_depthTex, uv + vec2(e.x, 0.0)).r));
    vec3 pL = viewPos(uv - vec2(e.x, 0.0), linearizeZ(texture(u_depthTex, uv - vec2(e.x, 0.0)).r));
    vec3 pT = viewPos(uv + vec2(0.0, e.y), linearizeZ(texture(u_depthTex, uv + vec2(0.0, e.y)).r));
    vec3 pB = viewPos(uv - vec2(0.0, e.y), linearizeZ(texture(u_depthTex, uv - vec2(0.0, e.y)).r));
    vec3 ddx = (abs(pR.z - pC.z) < abs(pC.z - pL.z)) ? (pR - pC) : (pC - pL);
    vec3 ddy = (abs(pT.z - pC.z) < abs(pC.z - pB.z)) ? (pT - pC) : (pC - pB);
    vec3 N = normalize(cross(ddx, ddy));
    vec3 V = camDir(pC);
    if (dot(N, V) < 0.0) N = -N;
    return N;
}

// Pick the view-space normal: the MRT geometry normal when present (smooth on
// tessellated meshes), otherwise the depth-reconstructed normal (fallback for
// primitives that write the sentinel, and when no normal buffer is supplied).
// The stored eye-space normal has +Z toward the camera; the GTAO integration
// space has vz > 0 forward, so flip Z only, then orient toward the camera the
// same way reconstructNormal does (flipping all three would corrupt x/y).
// Returns the view-space normal. Sets isExcluded when the pixel belongs to a
// primitive that opted out of AO: a line / label / wireframe writes the
// sentinel (0,0,0) into the normal buffer, and such pixels are left fully lit
// (AO = 1) instead of being shaded. With no normal buffer (u_hasNormal == 0)
// the depth-reconstructed normal is used and nothing is excluded.
vec3 selectNormal(vec2 uv, vec3 pC, out bool isExcluded)
{
    isExcluded = false;
    if (u_hasNormal != 0) {
        vec3 n = texture(u_normalTex, uv).xyz;
        if (dot(n, n) > 0.5) {
            // Stored eye-space normal: +Z faces the camera, so flip Z only to
            // reach the GTAO space (vz > 0 forward).
            vec3 N = normalize(vec3(n.x, n.y, -n.z));
            vec3 V = camDir(pC);
            // Clamp to the visible hemisphere. The exact normal can point away
            // from the camera at grazing silhouettes (sphere/cylinder edges) or
            // on the back side of two-sided meshes (cartoon ribbons), where the
            // horizon integral turns unstable and goes to near-black. Instead of
            // a hard flip (which inverts the in-plane direction and bands the
            // edge), fold it just inside the hemisphere toward the view vector.
            // Continuous and well defined even head-on (d = -1 -> N = V).
            float d = dot(N, V);
            if (d < 0.0) N = normalize(N - 1.01 * d * V);
            return N;
        }
        isExcluded = true;
    }
    return reconstructNormal(uv, pC);
}

// ---- Fast GI: visibility bitmask AO (Therrien et al., "Screen Space Indirect
// Lighting with Visibility Bitmask") ----
// Ported from Blender's real-time renderer (named EEVEE in Blender's sources):
// fast_gi::eval in source/blender/draw/engines/eevee/shaders/eevee_fast_gi.bsl.hh,
// AO part only, with the screen thickness estimator of
// eevee_ray_types_lib.bsl.hh. The rest of this file refers to it as "Blender".
// Works in GL view space (camera looks down -Z), like Blender. Differences: no
// HiZ (the full depth texture is read at LOD 0; emulating Blender's max-depth
// HiZ changed the result by about 0.01) and no temporal accumulation unless
// jittered (a high slice count stands in for Blender's 2 slices x accumulated
// samples).

// Bit operations of the visibility bitmask (popcount32, anglesToBitmask,
// bitmaskToVisibilityCosine). Uses the file constant PI, so it is included
// after its definition.
#include "fastgi_bitmask_inc.glsl"

// GL view position (z < 0 in front) of the window position (uv, depth).
vec3 glViewPos(vec2 uv, float d)
{
    vec3 p = viewPos(uv, linearizeZ(d));
    return vec3(p.xy, -p.z);
}

// GL view position -> (uv, window depth).
vec3 glProject(vec3 P)
{
    float vz = -P.z;
    vec2 xy = (u_isOrtho != 0) ? P.xy : P.xy / vz;
    vec2 uv = (xy - u_ndcToViewAdd) / u_ndcToViewMul;
    float d = (u_isOrtho != 0) ? (vz - u_depthUnpack.x) / u_depthUnpack.y
                               : u_depthUnpack.y - u_depthUnpack.x / vz;
    return vec3(uv, d);
}

// Blender ScreenThicknessParameters::pixel_depth_thickness_at (screen-range).
float pixelDepthThicknessAt(float vsZ, float avgPixRadius)
{
    if (u_isOrtho != 0) {
        float winmat22 = -2.0 / u_depthUnpack.y;
        return -(avgPixRadius + u_thicknessNear) * winmat22 * 0.5;
    }
    float winmat32 = -2.0 * u_depthUnpack.x;
    float vsThickness = vsZ * avgPixRadius - u_thicknessNear;
    float ndcThickness = vsThickness / (vsZ * (vsZ + vsThickness));
    return ndcThickness * winmat32 * 0.5;
}

// Trilinear lookup of the probe atlas at grid position g (probe centres at
// integer g). Atlas layout (texel (x + z * nx, y)): shared with
// AmbientProbeVolume::update (atlas size), probe_bake_frag.glsl and
// probe_fill_frag.glsl; change them together.
vec4 sampleProbeGrid(vec3 g)
{
    vec3 dim = vec3(u_probeDim);
    g = clamp(g, vec3(0.0), dim - 1.0);
    float z0 = floor(g.z);
    float z1 = min(z0 + 1.0, dim.z - 1.0);
    float fz = g.z - z0;
    vec2 atlas = vec2(dim.x * dim.z, dim.y);
    // Bilinear within a slice: g.xy is clamped to [0, n-1], so the filter
    // never reaches into the neighbouring slice.
    vec4 s0 = texture(u_probeAtlas, (vec2(g.x + z0 * dim.x, g.y) + 0.5) / atlas);
    vec4 s1 = texture(u_probeAtlas, (vec2(g.x + z1 * dim.x, g.y) + 0.5) / atlas);
    return mix(s0, s1, fz);
}

// Trilinear lookup of the probe atlas at world position pw.
vec4 sampleProbeAtlas(vec3 pw)
{
    return sampleProbeGrid((pw - u_probeOrigin) / u_probeSpacing - 0.5);
}

// Tricubic B-spline lookup at world position pw, from 8 trilinear lookups
// (Sigg & Hadwiger, GPU Gems 2 ch. 20). The B-spline is C2 across the probe
// cells and low-passes the probe values, so a zoomed-in surface does not show
// the grid as blotches the way the trilinear lookup does.
vec4 sampleProbeAtlasCubic(vec3 pw)
{
    vec3 g = (pw - u_probeOrigin) / u_probeSpacing - 0.5;
    vec3 i = floor(g);
    vec3 f = g - i;
    vec3 f2 = f * f;
    vec3 f3 = f2 * f;
    vec3 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec3 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec3 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec3 w3 = f3 / 6.0;
    vec3 a0 = w0 + w1;
    vec3 a1 = w2 + w3;
    vec3 c0 = i - 1.0 + w1 / max(a0, vec3(1e-6));
    vec3 c1 = i + 1.0 + w3 / max(a1, vec3(1e-6));
    vec4 r = vec4(0.0);
    r += a0.x * a0.y * a0.z * sampleProbeGrid(vec3(c0.x, c0.y, c0.z));
    r += a1.x * a0.y * a0.z * sampleProbeGrid(vec3(c1.x, c0.y, c0.z));
    r += a0.x * a1.y * a0.z * sampleProbeGrid(vec3(c0.x, c1.y, c0.z));
    r += a1.x * a1.y * a0.z * sampleProbeGrid(vec3(c1.x, c1.y, c0.z));
    r += a0.x * a0.y * a1.z * sampleProbeGrid(vec3(c0.x, c0.y, c1.z));
    r += a1.x * a0.y * a1.z * sampleProbeGrid(vec3(c1.x, c0.y, c1.z));
    r += a0.x * a1.y * a1.z * sampleProbeGrid(vec3(c0.x, c1.y, c1.z));
    r += a1.x * a1.y * a1.z * sampleProbeGrid(vec3(c1.x, c1.y, c1.z));
    return r;
}

// Distant visibility from the probe moments m = (m0, m1.xyz) at world normal
// nw, cosine-weighted (m0 + 2 dot(m1, N); 1 unoccluded, 1 on an open flat
// surface) and mixed by the strength. Weighting the 8 probes by facing and
// validity (as Blender does) was tried and left out, since with probes 3 A apart (coarser
// than an atom) it lets the dark probes in the gaps in front of a sunk atom
// dominate and paints dark smudges on CPK spheres.
float probeMomentVisibility(vec4 m, vec3 nw)
{
    return mix(1.0, clamp(m.x + 2.0 * dot(m.yzw, nw), 0.0, 1.0), u_probeStrength);
}

// Distant visibility at world position pw with world normal nw from the
// trilinear lookup, for the per-sample bounce, where the cost matters (the
// receiver's own AO term uses the tricubic lookup in main()).
float probeVisibility(vec3 pw, vec3 nw)
{
    vec3 pq = pw + nw * u_probeBias;
    vec4 m = sampleProbeAtlas(pq);
    return probeMomentVisibility(m, nw);
}

// Radiance of the occluding surface at uv: the lit scene colour with the
// scene's linear fog taken out (c = mix(fog, lit, fogVis)). The scene colour
// is not occluded yet; Blender reads the previous frame's final radiance, in
// which an occluder deep in a cavity is itself dark. Approximate that with the
// baked probes: darken the occluder's ambient part (fraction f, stored in the
// scene normal's length as 2 - f) by its distant visibility. pG / nG: the
// occluder position and the normal of its side facing the receiver, in the
// GTAO view space.
vec3 occluderRadiance(vec2 uv, float viewZ, vec4 sn, vec3 pG, vec3 nG)
{
    vec3 c = texture(u_sceneColorTex, uv).rgb;
    float fogVis = clamp((u_fogEnd - viewZ) * u_fogScale, 0.0, 1.0);
    vec3 lit = max((c - (1.0 - fogVis) * u_fogColor) / max(fogVis, 0.05), vec3(0.0));
    if (u_hasProbe != 0) {
        float f = clamp(2.0 - length(sn.xyz), 0.0, 1.0);
        vec3 pw = (u_viewToWorld * vec4(pG, 1.0)).xyz;
        vec3 nw = normalize(mat3(u_viewToWorld) * nG);
        lit *= 1.0 - f * (1.0 - probeVisibility(pw, nw));
    }
    return lit;
}

// Fast GI visibility bitmask AO (see the port note above). Returns the
// cosine-weighted visibility; with u_bounce, also the near-field indirect
// irradiance in `bounce`: every sample that newly occludes sectors of the
// slice adds the radiance of the surface it hit, weighted by the cosine
// weight of those sectors and by how much that surface faces the receiver
// (Blender weights its radiance samples the same way). For occluders of uniform
// radiance L this is L * (1 - visibility), i.e. the light the ambient term
// loses, given back in the occluders' colour.
float fastGIVisibility(vec3 vP, vec3 vN, float searchDistance, int sliceCount, int sampleCount,
                       vec4 noise, out vec3 bounce)
{
    const float angleBias = 1.0 / (1.0 - 0.05);  // Blender's default bias (fast_gi_bias)
    vec3 vV = (u_isOrtho != 0) ? vec3(0.0, 0.0, 1.0) : normalize(-vP);
    // Average pixel radius at unit Z (perspective) / absolute (ortho), scaled
    // by the minimum pixel thickness "eyeballed for 64 samples". Taken from the
    // full-resolution pixel so the half-res pass (while the view moves) gets
    // the same thickness, hence the same occlusion, as the full-res pass.
    float avgPix = length(u_ndcToViewMul * u_fullPixelSize) *
                   (4.0 * sqrt(64.0 / float(sampleCount)));
    vec3 ssStart = glProject(vP);

    float weightAccum = 0.0;
    float occlusionAccum = 0.0;
    vec3 bounceAccum = vec3(0.0);
    for (int slice = 0; slice < sliceCount; slice++) {
        float ang = 2.0 * PI * ((float(slice) + noise.x) / float(2 * sliceCount));
        vec2 vDir = vec2(cos(ang), sin(ang));
        vec3 vB = normalize(cross(vV, vec3(vDir, 0.0)));
        vec3 vT = cross(vB, vV);

        vec3 nProj = vN - vB * dot(vN, vB);
        float vNLength = length(nProj);
        nProj /= max(vNLength, 1e-6);
        float vNAngle = sign(dot(nProj, vT)) * acos(clamp(dot(nProj, vV), -1.0, 1.0));
        vNAngle += (noise.z - 0.5) * (PI / 32.0) * angleBias;

        uint sliceBitmask = 0u;
        vec3 sliceBounce = vec3(0.0);
        for (int side = 0; side < 2; side++) {
            vec3 dir = vec3((side == 0) ? vDir : -vDir, 0.0);
            vec3 ssEnd = glProject(vP + dir * searchDistance);
            vec3 ssDir = ssEnd - ssStart;
            if (dot(ssDir.xy, ssDir.xy) < 1e-10) ssDir.xy = vec2(0.0, 1e-5);
            float lenSqr = dot(ssDir, ssDir);
            bool vert = abs(ssDir.x / u_viewportPixelSize.x) < abs(ssDir.y / u_viewportPixelSize.y);
            ssDir /= vert ? abs(ssDir.y) : abs(ssDir.x);
            ssDir *= vert ? u_viewportPixelSize.y : u_viewportPixelSize.x;
            float maxTime = sqrt(lenSqr / max(dot(ssDir, ssDir), 1e-20));
            // Clip to the screen.
            vec2 tb = vec2(1e20);
            if (ssDir.x > 0.0) tb.x = (1.0 - ssStart.x) / ssDir.x;
            if (ssDir.x < 0.0) tb.x = -ssStart.x / ssDir.x;
            if (ssDir.y > 0.0) tb.y = (1.0 - ssStart.y) / ssDir.y;
            if (ssDir.y < 0.0) tb.y = -ssStart.y / ssDir.y;
            maxTime = min(maxTime, min(tb.x, tb.y));
            // Cap the march in pixels, as the GTAO path does (zoomed in, the
            // search distance spans hundreds of pixels). The far occluders
            // beyond the cap are left to the baked probes.
            maxTime = min(maxTime, u_maxScreenspaceRadius);

            // ScreenThicknessEstimator::init(ray.origin.z) (Blender passes the
            // view-space Z here).
            vec2 prevSlope = vec2(0.0);
            float prevZ = vP.z;
            float prevT = 0.0;

            for (int j = 0; j < sampleCount; j++) {
                float r = (float(j) + noise.y) / float(sampleCount);
                float time = 1.0 + r * r * maxTime;
                vec2 suv = ssStart.xy + ssDir.xy * time;
                float sd = texture(u_depthTex, suv).r;
                if (sd >= 1.0) continue;  // background

                float sViewZ = glViewPos(suv, sd).z;
                float minThick = pixelDepthThicknessAt(sViewZ, avgPix);
                // ScreenThicknessEstimator::thickness
                float dz = sd - prevZ;
                float slope = dz / (time - prevT);
                float thick = abs(dz);
                if (any(greaterThan(abs(prevSlope - slope), abs(prevSlope)))) thick = 0.0;
                thick = max(thick, minThick);
                prevSlope = vec2(slope, prevSlope.x);
                prevT = time;
                prevZ = sd;

                vec3 pFront = glViewPos(suv, sd + 2.0 * 2.4e-7);
                vec3 pBack = glViewPos(suv, min(sd + thick, 1.0));
                vec3 lsF = (pFront - vP) / searchDistance;
                vec3 lsB = (pBack - vP) / searchDistance;
                float maxDist = sqrt(clamp(1.0 - dot(lsF.xy, lsF.xy), 0.0, 1.0));
                lsF.z = clamp(lsF.z, -maxDist, maxDist);
                lsB.z = clamp(lsB.z, -maxDist, maxDist);
                if (lsF.z == lsB.z) continue;

                vec2 theta = acos(clamp(vec2(dot(normalize(lsF), vV), dot(normalize(lsB), vV)),
                                        -1.0, 1.0));
                theta.y = max(theta.x, theta.y);
                theta = (side == 0) ? theta.xy : -theta.yx;
                uint sampleBitmask = anglesToBitmask((theta - vNAngle) * angleBias);
                if (u_bounce != 0) {
                    uint newBits = sampleBitmask & ~sliceBitmask;
                    if (newBits != 0u) {
                        // Cosine weight of the newly occluded sectors.
                        float w = 1.0 - bitmaskToVisibilityCosine(newBits);
                        // Two-sided surfaces (ribbons): either side emits.
                        vec4 sn = texture(u_normalTex, suv);
                        vec3 dirL = normalize(lsF);  // receiver -> occluder (GL eye)
                        float facing = 1.0;
                        vec3 nE = -dirL;             // no normal: face the receiver
                        if (dot(sn.xyz, sn.xyz) > 0.25) {
                            nE = normalize(sn.xyz);
                            float d = dot(nE, -dirL);
                            // Two-sided surfaces (ribbons): either side emits;
                            // take the side facing the receiver.
                            if (d < 0.0) nE = -nE;
                            facing = abs(d);
                        }
                        vec3 rad = occluderRadiance(suv, -pFront.z, sn,
                                                    vec3(pFront.xy, -pFront.z),
                                                    vec3(nE.xy, -nE.z));
                        sliceBounce += rad * (w * facing);
                    }
                }
                sliceBitmask |= sampleBitmask;
            }
        }
        occlusionAccum += bitmaskToVisibilityCosine(sliceBitmask) * vNLength;
        bounceAccum += sliceBounce * vNLength;
        weightAccum += vNLength;
    }
    bounce = bounceAccum / max(weightAccum, 1e-6);
    return occlusionAccum / max(weightAccum, 1e-6);
}

// GTAO horizon integration (XeGTAO). Returns the visibility in [0.03, 1].
float gtaoVisibility(vec3 pixCenterPos, vec3 N, float viewspaceZ, float effectRadius,
                     float finalValuePower)
{
    // ---- GTAO horizon integration (depth-only) ----
    // Slice count sets the angular sampling = base noise level; a high count
    // keeps grain low without temporal accumulation. The AO spread (how far the
    // occlusion reaches) is controlled separately by u_effectRadius. Clamped to
    // a sane range so a bad scene value cannot stall the GPU.
    int sliceCount = clamp(u_sliceCount, 1, 16);
    int stepsPerSlice = clamp(u_stepCount, 1, 16);
    const float sampleDistributionPower = 2.0;
    const float falloffRangeRatio = 0.615;
    const float pixelTooCloseThreshold = 1.3;

    // Nudge slightly toward the camera to reduce self-occlusion precision
    // artifacts.
    viewspaceZ *= 0.99999;
    pixCenterPos = viewPos(v_uv, viewspaceZ);
    vec3 viewVec = camDir(pixCenterPos);


    vec2 ndcToViewMul_x_pixelSize = u_ndcToViewMul * u_viewportPixelSize;
    // Orthographic: a pixel's world size is constant; perspective: it scales
    // with viewZ.
    float pixViewSize = ndcToViewMul_x_pixelSize.x;
    if (u_isOrtho == 0) pixViewSize *= viewspaceZ;
    float screenspaceRadius = effectRadius / max(pixViewSize, 1e-6);

    // Clamp the screen-space radius so the horizon samples stay cache-local
    // when zoomed in. Without a depth MIP chain a world-space radius maps to a
    // huge pixel radius at close range, scattering the 54 texture reads across
    // the screen and causing frame drops. The effective world radius is derived
    // back from the clamped value so the falloff stays consistent (no change
    // when the radius is not clamped). The cap is supplied in this pass's pixel
    // units (scaled by the caller to a fixed full-resolution-equivalent radius)
    // so the half-resolution AO pass clamps at the same world radius and yields
    // the same occlusion as the full-resolution pass.
    screenspaceRadius = min(screenspaceRadius, u_maxScreenspaceRadius);
    float effectiveRadius = screenspaceRadius * pixViewSize;

    float falloffRange = falloffRangeRatio * effectiveRadius;
    float falloffFrom = effectiveRadius * (1.0 - falloffRangeRatio);
    float falloffMul = -1.0 / falloffRange;
    float falloffAdd = falloffFrom / falloffRange + 1.0;

    // Per-pixel interleaved gradient noise, rotated per temporal-SS sample by
    // u_aoNoiseOffset so that accumulating jittered frames averages the GTAO
    // grain away (0 for a single, non-accumulated frame = original behavior).
    float noiseSlice = fract(ign(gl_FragCoord.xy) + u_aoNoiseOffset);
    float noiseSample =
        fract(noiseSlice + dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));

    float minS = pixelTooCloseThreshold / screenspaceRadius;

    float visibility = 0.0;

    for (int slice = 0; slice < sliceCount; slice++) {
        float sliceK = (float(slice) + noiseSlice) / float(sliceCount);
        float phi = sliceK * PI;
        float cosPhi = cos(phi);
        float sinPhi = sin(phi);
        // In-screen sampling direction in pixels. GL UV is bottom-up, so the
        // y component keeps the same sign as the view-space direction (XeGTAO
        // negates it for the top-down DX convention).
        vec2 omega = vec2(cosPhi, sinPhi) * screenspaceRadius;

        vec3 directionVec = vec3(cosPhi, sinPhi, 0.0);
        vec3 orthoDirectionVec = directionVec - dot(directionVec, viewVec) * viewVec;
        vec3 axisVec = normalize(cross(orthoDirectionVec, viewVec));
        vec3 projectedNormalVec = N - axisVec * dot(N, axisVec);
        float signNorm = sign(dot(orthoDirectionVec, projectedNormalVec));
        float projectedNormalVecLength = length(projectedNormalVec);
        float cosNorm =
            clamp(dot(projectedNormalVec, viewVec) / max(projectedNormalVecLength, 1e-6),
                  0.0, 1.0);
        float n = signNorm * acos(cosNorm);

        float lowHorizonCos0 = cos(n + HALF_PI);
        float lowHorizonCos1 = cos(n - HALF_PI);
        float horizonCos0 = lowHorizonCos0;
        float horizonCos1 = lowHorizonCos1;

        for (int step = 0; step < stepsPerSlice; step++) {
            float stepBaseNoise = float(slice + step * stepsPerSlice) * 0.6180339887;
            float stepNoise = fract(noiseSample + stepBaseNoise);
            float s = (float(step) + stepNoise) / float(stepsPerSlice);
            s = pow(s, sampleDistributionPower);
            s += minS;
            vec2 sampleOffset = round(s * omega) * u_viewportPixelSize;

            vec2 sp0 = v_uv + sampleOffset;
            vec2 sp1 = v_uv - sampleOffset;
            vec3 samplePos0 = viewPos(sp0, linearizeZ(texture(u_depthTex, sp0).r));
            vec3 samplePos1 = viewPos(sp1, linearizeZ(texture(u_depthTex, sp1).r));

            vec3 sampleDelta0 = samplePos0 - pixCenterPos;
            vec3 sampleDelta1 = samplePos1 - pixCenterPos;
            float sampleDist0 = length(sampleDelta0);
            float sampleDist1 = length(sampleDelta1);
            vec3 sampleHorizonVec0 = sampleDelta0 / max(sampleDist0, 1e-6);
            vec3 sampleHorizonVec1 = sampleDelta1 / max(sampleDist1, 1e-6);

            float weight0 = clamp(sampleDist0 * falloffMul + falloffAdd, 0.0, 1.0);
            float weight1 = clamp(sampleDist1 * falloffMul + falloffAdd, 0.0, 1.0);

            // Do not let line / label primitives (sentinel normal) occlude other
            // surfaces: drop the occlusion weight of any sample that lands on
            // one, so a wireframe / bond line casts no AO onto the geometry
            // behind it. Only fetch the normal where the sample can still
            // occlude (weight > 0); a zero-weight sample contributes nothing
            // either way, so skipping it is exact and saves the texture read.
            if (u_hasNormal != 0) {
                if (weight0 > 0.0) {
                    vec3 sn0 = texture(u_normalTex, sp0).xyz;
                    if (dot(sn0, sn0) < 0.5) weight0 = 0.0;
                }
                if (weight1 > 0.0) {
                    vec3 sn1 = texture(u_normalTex, sp1).xyz;
                    if (dot(sn1, sn1) < 0.5) weight1 = 0.0;
                }
            }

            float shc0 = dot(sampleHorizonVec0, viewVec);
            float shc1 = dot(sampleHorizonVec1, viewVec);
            shc0 = mix(lowHorizonCos0, shc0, weight0);
            shc1 = mix(lowHorizonCos1, shc1, weight1);
            horizonCos0 = max(horizonCos0, shc0);
            horizonCos1 = max(horizonCos1, shc1);
        }

        projectedNormalVecLength = mix(projectedNormalVecLength, 1.0, 0.05);
        float h0 = -acos(clamp(horizonCos1, -1.0, 1.0));
        float h1 = acos(clamp(horizonCos0, -1.0, 1.0));
        float iarc0 = (cosNorm + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) / 4.0;
        float iarc1 = (cosNorm + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) / 4.0;
        visibility += projectedNormalVecLength * (iarc0 + iarc1);
    }

    visibility /= float(sliceCount);
    visibility = pow(max(visibility, 0.0), finalValuePower);
    visibility = max(0.03, visibility);
    return visibility;
}

void main()
{
    o_Bounce = vec4(0.0);
    float rawDepth = texture(u_depthTex, v_uv).r;
    float viewspaceZ = linearizeZ(rawDepth);
    vec3 pixCenterPos = viewPos(v_uv, viewspaceZ);
    bool isExcluded;
    vec3 N = selectNormal(v_uv, pixCenterPos, isExcluded);

    if (u_debugMode == 1) {
        // Normal fed to the integration, as RGB (debugging).
        o_FragColor = vec4(N * 0.5 + 0.5, 1.0);
        return;
    }
    if (u_debugMode == 2) {
        float vnear = u_depthUnpack.x / u_depthUnpack.y;
        float vfar = u_depthUnpack.x / (u_depthUnpack.y - 1.0);
        float g = clamp((viewspaceZ - vnear) / (vfar - vnear), 0.0, 1.0);
        o_FragColor = vec4(vec3(1.0 - g), 1.0);
        return;
    }

    // Far plane / no geometry: fully unoccluded (and flat edges).
    if (rawDepth >= 1.0) {
        o_FragColor = vec4(1.0);
        return;
    }

    // Line / label / wireframe primitive: keep it fully lit (AO = 1, flat edges).
    if (isExcluded) {
        o_FragColor = vec4(1.0);
        return;
    }

    // Depth-discontinuity edges for the denoise pass (uses un-nudged depth).
    vec2 ep = u_viewportPixelSize;
    float zL = linearizeZ(texture(u_depthTex, v_uv - vec2(ep.x, 0.0)).r);
    float zR = linearizeZ(texture(u_depthTex, v_uv + vec2(ep.x, 0.0)).r);
    float zT = linearizeZ(texture(u_depthTex, v_uv + vec2(0.0, ep.y)).r);
    float zB = linearizeZ(texture(u_depthTex, v_uv - vec2(0.0, ep.y)).r);
    float packedEdges = packEdges(calculateEdges(viewspaceZ, zL, zR, zT, zB));

    if (u_method == 1) {
        float n0 = fract(ign(gl_FragCoord.xy) + u_aoNoiseOffset);
        vec4 noise = vec4(n0, fract(n0 + 0.5698402909 + u_aoNoiseOffset * 0.7548776662),
                          fract(ign(gl_FragCoord.yx + 17.0) + u_aoNoiseOffset), 0.0);
        vec3 vP = vec3(pixCenterPos.xy, -pixCenterPos.z);
        vec3 vN = normalize(vec3(N.xy, -N.z));
        vec3 bounce;
        float keyVis = 1.0;
        float vis = fastGIVisibility(vP, vN, u_effectRadius, clamp(u_sliceCount, 1, 32),
                                     clamp(u_stepCount, 1, 32), noise, bounce);
        o_Bounce = vec4(bounce, 1.0);
        // Linear visibility, as Blender stores it (saturate(result), no power).
        vis = clamp(vis, 0.0, 1.0);
        if (u_hasProbe != 0) {
            // Distant visibility from the probes (tricubic B-spline lookup,
            // smooth when zoomed in; see probeMomentVisibility). Both terms
            // estimate the same sky visibility, so take the smaller one:
            // multiplying them (as Blender multiplies the probe irradiance by
            // the near-field visibility) counts the near occluders twice,
            // since the 3 A probes see them too. The screen term keeps the
            // contact detail the grid cannot resolve, the probes the large
            // cavities.
            vec3 pw = (u_viewToWorld * vec4(pixCenterPos, 1.0)).xyz;
            vec3 nw = normalize(mat3(u_viewToWorld) * N);
            vec3 pq = pw + nw * u_probeBias;
            vec4 m = sampleProbeAtlasCubic(pq);
            vis = min(vis, probeMomentVisibility(m, nw));
            if (u_keyShadow > 0.0) {
                // Soft shadow of the key light from the same probes: the L1
                // reconstruction of the directional visibility, V(L) = m0 +
                // 3 dot(m1, L), divided by its value over an open plane
                // (0.5 + 0.75 N.L), which takes the receiver's own half space
                // out, so a free surface stays lit.
                vec3 lw = normalize(mat3(u_viewToWorld) *
                                    vec3(u_lightDirEye.xy, -u_lightDirEye.z));
                float vl = m.x + 3.0 * dot(m.yzw, lw);
                float ref = 0.5 + 0.75 * max(dot(nw, lw), 0.0);
                keyVis = mix(1.0, pow(clamp(vl / ref, 0.0, 1.0), u_keyShadowPower),
                             u_keyShadow * u_probeStrength);
            }
        }
        o_FragColor = vec4(vis, packedEdges, keyVis, 1.0);
        return;
    }

    float visibility = gtaoVisibility(pixCenterPos, N, viewspaceZ, u_effectRadius,
                                      u_finalValuePower);

    // R = AO term, G = packed edges (consumed by the denoise pass).
    o_FragColor = vec4(visibility, packedEdges, 0.0, 1.0);
}
