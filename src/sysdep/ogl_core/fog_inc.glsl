// -*-Mode: C++;-*-
//
//  Fog GLSL include file
//

#pragma once

////////////////////
// FogBlock UBO: binding point 1

layout(std140) uniform FogBlock {
    float u_fogEnd;    // offset 0
    float u_fogScale;  // offset 4
    float u_occluderPass;  // offset 8: 1 = occluder-only pass (the Fast GI
                           // probe bake); primitives without a normal discard
    float _fog_p2;     // offset 12
    vec3 u_fogColor;   // offset 16
    float _fog_p3;     // offset 28
    // Light intensities (lighting_inc.glsl). Shared with the fog in one block
    // because every lit primitive already updates it per draw.
    float u_lightAmbient;   // offset 32
    float u_lightDiffuse;   // offset 36
    float u_lightSpecular;  // offset 40
    float u_lightNoClamp;   // offset 44: 1 = do not clamp (HDR scene target)
    vec4 u_lightDir;        // offset 48: .xyz = eye-space direction to the light,
                            // .w = specular exponent
    vec4 u_matExtra;        // offset 64: .x = metalness, .y = toon (1 =
                            // flat tones, 0 = smooth), .z = Fresnel rim,
                            // .w = 1: the toon under POV-Ray's lights and gamma
};

////////////////////

// A material lit by the ambient light alone (no diffuse, no specular:
// nolighting, shadow). It shows its colour as given: drawn without a normal
// (no AO, no tone curve, not an AO occluder), like lines and labels.
bool isAmbientOnlyLight()
{
    return u_lightDiffuse <= 0.0 && u_lightSpecular <= 0.0;
}

// The occluder-only pass (the Fast GI probe bake, DisplayContext::
// setOccluderPass): a primitive drawn without a normal casts no AO, so it
// discards its fragments there.
bool isOccluderPass()
{
    return u_occluderPass > 0.5;
}

// Material of the lit colour for the Fast GI composite (MRT attachment 2,
// ao_composite_frag.glsl): the light of the renderer being drawn, which the
// scene sets per renderer from its material (Scene::getMaterialLight).
// r = diffuse / ambient and b = ambient, each as x / (1 + x) to fit [0, 1);
// g = the roughness of the Blinn-Phong exponent n as GGX alpha
// sqrt(2 / (n + 2)); a = 1, or 0.75 for a material lit by the ambient light
// alone (no diffuse, no specular: nolighting, shadow), which is a flat look
// the composite leaves without AO (0 = no material, cleared).
vec4 encodeMaterial()
{
    float ka = max(u_lightAmbient, 1e-3);
    float r = u_lightDiffuse / ka;
    float rough = sqrt(2.0 / (max(u_lightDir.w, 0.0) + 2.0));
    return vec4(r / (1.0 + r), rough, ka / (1.0 + ka), isAmbientOnlyLight() ? 0.75 : 1.0);
}

vec4 fragFogColor(in vec4 color, in float frag_alpha, in float fogCoord)
{
    float fog = (u_fogEnd - fogCoord) * u_fogScale;
    fog = clamp(fog, 0.0, 1.0);

    float alpha = color.a * frag_alpha;
    vec3 fogmixed = mix(u_fogColor, vec3(color), fog);
    color = vec4(fogmixed, alpha);

    return color;
}

float ffog(in float ecDistance)
{
    return abs(ecDistance);
}
