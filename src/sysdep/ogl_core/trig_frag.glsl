// -*-Mode: C++;-*-
//
//  Triangle fragment shader for OpenGL
//
#define varying in

#include "lighting_inc.glsl"
#include "fog_inc.glsl"

////////////////////
// DrawParamsBlock UBO: binding point 2

layout(std140) uniform DrawParamsBlock {
    float frag_alpha;       // offset 0
    int   enable_lighting;  // offset 4
    int   u_nodepth;        // offset 8
    float _pad;             // offset 12
};

////////////////////
// Varying variables

varying vec4 v_frontColor;
varying float v_fogCoord;
varying vec3 v_ecNormal;

layout(location = 0) out vec4 o_FragColor;
// MRT eye-space normal for GTAO (sentinel (0,0,0) -> reconstruct from depth).
// Its length is 2 - (ambient fraction of the lit colour), see lighting_inc.glsl.
// vec4 to match o_FragColor (Apple Metal GL mishandles mixed vec4/vec3 MRT).
layout(location = 1) out vec4 o_Normal;
// MRT material for the Fast GI composite (fog_inc.glsl encodeMaterial; 0 = none).
layout(location = 2) out vec4 o_Material;

void main(void)
{
    // Drawn without a normal: no vertex normal, lighting off (a wireframe),
    // or a material lit by the ambient light alone (isAmbientOnlyLight).
    // Such a pixel gets no AO and no tone curve and occludes nothing, so it
    // is left out of the occluder-only pass (the probe bake).
    bool unlit = enable_lighting == 0 || isAmbientOnlyLight();
    bool hasNormal = !unlit && dot(v_ecNormal, v_ecNormal) > 1e-12;
    if (!hasNormal && isOccluderPass()) discard;

    // Lit per pixel (the vertex shader passes the vertex colour).
    vec4 color = v_frontColor;
    float ambFrac = 1.0;
    if (enable_lighting != 0 && dot(v_ecNormal, v_ecNormal) > 1e-12) {
        color = flight2(normalize(v_ecNormal), vec4(0.0), v_frontColor);
        ambFrac = g_ambientFraction;
    }
    o_FragColor = fragFogColor(color, frag_alpha, v_fogCoord);

    o_Normal = hasNormal
                   ? vec4(normalize(v_ecNormal) * (2.0 - clamp(ambFrac, 0.0, 1.0)), 1.0)
                   : vec4(0.0, 0.0, 0.0, 1.0);
    o_Material = hasNormal ? encodeMaterial() : vec4(0.0);
}
