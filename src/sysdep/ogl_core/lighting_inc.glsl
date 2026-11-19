// -*-Mode: C++;-*-
//
//  Common GLSL include file
//

#pragma once

#include "fog_inc.glsl"

// Fraction of the lit colour that comes from the ambient light (luminance), so
// the composite can apply the AO to the ambient light only, as Blender EEVEE
// does (direct light is not occluded). It is stored in the MRT normal's length
// (encodeNormalAmbient), not in .w: the scene pass blends, and blending would
// mix a .w < 1 normal with the background. Length 1 = fraction 1 (the plain
// unit normals other shaders write keep the AO on the whole colour).
float g_ambientFraction = 1.0;

vec4 encodeNormalAmbient(vec3 n, float ambientFraction)
{
    return vec4(normalize(n) * (2.0 - clamp(ambientFraction, 0.0, 1.0)), 1.0);
}

////////////////////
// Lighting

vec4 Ambient;
vec4 Diffuse;
vec4 Specular;

#if 0
// void DirectionalLight(in int i, in vec3 normal)
void DirectionalLight(in vec3 normal)
{
    float nDotVP;  // normal . light direction
    float nDotHV;  // normal . light half vector
    float pf;      // power factor

    nDotVP = max(0.0, dot(normal, normalize(vec3(gl_LightSource[0].position))));
    nDotHV = max(0.0, dot(normal, vec3(gl_LightSource[0].halfVector)));

    if (nDotVP == 0.0)
        pf = 0.0;
    else
        pf = pow(nDotHV, gl_FrontMaterial.shininess);

    Ambient += gl_LightSource[0].ambient;
    Diffuse += gl_LightSource[0].diffuse * nDotVP;
    Specular += gl_LightSource[0].specular * pf;
}

vec4 flight(in vec3 normal, in vec4 ecPosition, in vec4 a_color)
{
    vec4 color;
    vec3 ecPosition3;
    vec3 eye;

    ecPosition3 = (vec3(ecPosition)) / ecPosition.w;
    eye = vec3(0.0, 0.0, 1.0);

    // Clear the light intensity accumulators
    Ambient = vec4(0.0);
    Diffuse = vec4(0.0);
    Specular = vec4(0.0);

    // pointLight(0, normal, eye, ecPosition3);
    DirectionalLight(normal);

    color = gl_LightModel.ambient * a_color;
    color += Ambient * a_color;
    color += Diffuse * a_color;
    color += Specular * gl_FrontMaterial.specular;
    color = clamp(color, 0.0, 1.0);
    return color;
}
#endif

//////////
// simple lighting version

// These should be set as uniforms from the application
// uniform vec4 u_LightSourcePosition;
// uniform float u_FrontMaterialShininess;
// uniform float u_LightSourceAmbient;
// uniform float u_LightSourceDiffuse;
// uniform float u_LightSourceSpecular;

void directionalLight2(in vec3 normal)
{
    // Direction and shininess are fixed; intensities come from FogBlock.
    vec4 u_LightSourcePosition = vec4(1.0, 1.0, 1.5, 0.0);
    float u_FrontMaterialShininess = 32.0;

    float nDotVP;  // normal . light direction
    float nDotHV;  // normal . light half vector
    float pf;      // power factor

    vec3 lightSource_position = u_LightSourcePosition.xyz;
    vec3 lightSource_halfVector = normalize(lightSource_position + vec3(0, 0, 1));
    nDotVP = max(0.0, dot(normal, normalize(lightSource_position)));
    nDotHV = max(0.0, dot(normal, lightSource_halfVector));

    // float shininess = u_light.shininess;
    float shininess = u_FrontMaterialShininess;
    if (nDotVP == 0.0)
        pf = 0.0;
    else
        pf = pow(nDotHV, shininess);

    Ambient = vec4(vec3(u_lightAmbient), 0.0);
    Diffuse = vec4(vec3(u_lightDiffuse), 0.0) * nDotVP;
    Specular = vec4(vec3(u_lightSpecular), 0.0) * pf;
}

vec4 flight2(in vec3 normal, in vec4 ecPosition, in vec4 in_color)
{
    vec4 color;

    directionalLight2(normal);

    // Intensities: u_lightAmbient = ambient total (0.4 = the former light-model
    // 0.2 + light 0.2), u_lightSpecular = specular x material (0.16 = 0.4 x 0.4).
    vec3 amb = Ambient.rgb * in_color.rgb;
    vec3 rgb = amb + Diffuse.rgb * in_color.rgb + Specular.rgb;
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
    g_ambientFraction = clamp(dot(amb, LUM) / max(dot(rgb, LUM), 1e-4), 0.0, 1.0);
    color = vec4(rgb, in_color.a);
    if (u_lightNoClamp < 0.5) color = clamp(color, 0.0, 1.0);
    return color;
}
