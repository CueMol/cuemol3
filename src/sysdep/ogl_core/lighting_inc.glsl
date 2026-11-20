// -*-Mode: C++;-*-
//
//  Common GLSL include file
//

#pragma once

#include "fog_inc.glsl"
#include "tonemap_inc.glsl"

// Fraction of the lit colour that comes from the ambient light (luminance), so
// the composite can apply the AO to the ambient light only (direct light is
// not occluded). It is stored in the MRT normal's length
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
    // Direction, specular exponent and intensities come from FogBlock.
    vec4 u_LightSourcePosition = vec4(u_lightDir.xyz, 0.0);
    float u_FrontMaterialShininess = u_lightDir.w;

    float nDotVP;  // normal . light direction
    float nDotHV;  // normal . light half vector
    float pf;      // power factor

    vec3 lightSource_position = u_LightSourcePosition.xyz;
    vec3 lightSource_halfVector = normalize(lightSource_position + vec3(0, 0, 1));
    nDotVP = max(0.0, dot(normal, normalize(lightSource_position)));
    nDotHV = max(0.0, dot(normal, lightSource_halfVector));

    // float shininess = u_light.shininess;
    float shininess = u_FrontMaterialShininess;
    // pow(0, y) is undefined for y <= 0 (NaN on GPUs), and materials such as
    // nolighting and shadow have shininess 0: keep the base above 0 (a
    // fixed-function pow(x, 0) = 1 for every x).
    if (nDotVP == 0.0)
        pf = 0.0;
    else
        pf = pow(max(nDotHV, 1e-6), max(shininess, 0.0));

    // Toon (u_matExtra.y > 0): flat tones, as the brilliance-0 finishes of
    // POV-Ray light every surface facing a light whatever its angle, and a
    // hard-edged spot where a smooth highlight would pass half its peak.
    if (u_matExtra.y > 0.5) {
        float key = (dot(normal, lightSource_position) > 0.0) ? 1.0 : 0.0;
        if (u_matExtra.w > 0.5) {
            // Without AO, as POV-Ray renders CueMol's export: the key light
            // (TOON_KEY of the diffuse light) and a shadowless flash light
            // from the camera (TOON_FLASH), so the side the key light misses
            // keeps the flash tone. The spot is the flash light's (its half
            // vector is the view axis); POV-Ray shows no key light spot.
            const float TOON_KEY = 0.5 / 1.3;
            const float TOON_FLASH = 0.8 / 1.3;
            float flash = (normal.z > 0.0) ? 1.0 : 0.0;
            nDotVP = TOON_KEY * key + TOON_FLASH * flash;
            float flashPf = pow(max(normal.z, 1e-6), max(shininess, 0.0));
            pf = (flash > 0.0 && flashPf > 0.5) ? 1.0 : 0.0;
        } else {
            // With AO: two tones and the spot under the usual key light.
            nDotVP = key;
            pf = (key > 0.0 && pf > 0.5) ? 1.0 : 0.0;
        }
    }

    Ambient = vec4(vec3(u_lightAmbient), 0.0);
    Diffuse = vec4(vec3(u_lightDiffuse), 0.0) * nDotVP;
    Specular = vec4(vec3(u_lightSpecular), 0.0) * pf;
}

// Environment seen in a mirror direction (eye space): a sky gradient along
// the camera up axis, bright above and dark below. The dark side stands for
// what a metal mirrors in the ray tracer below and behind it (its neighbours'
// shaded sides and the background), which gives a metal its contrast.
const vec3 ENV_SKY = vec3(1.2);
const vec3 ENV_GROUND = vec3(0.15);

// Reflection of the environment by a metal (u_matExtra.x = metalness). Real
// metals get most of their look from what they mirror, not from the one
// light's highlight; without it a metal reads as dark plastic. The mirror
// direction picks the sky gradient, blurred toward its mean as the surface
// gets rougher (the GGX alpha of the specular exponent), and the metal's
// colour tints it. It is scaled by the ambient light, which stands for the
// sky's brightness, so it follows lightBrightness and the AO method. In the
// Fast GI composite it falls in the non-ambient part, where the specular
// occlusion darkens it in the cavities.
vec3 envReflection(vec3 normal, vec3 albedo)
{
    float metal = u_matExtra.x;
    if (metal <= 0.0) return vec3(0.0);
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), normal);
    // Rougher surfaces blur the horizon: a wider blend band, not a flat mean.
    // The band never gets sharp: a mirror-sharp horizon cuts a sphere in two.
    float alpha = sqrt(2.0 / (max(u_lightDir.w, 0.0) + 2.0));
    float band = max(alpha, 0.5);
    float t = smoothstep(-band, band, r.y);
    vec3 sky = mix(ENV_GROUND, ENV_SKY, t);
    return metal * albedo * sky * u_lightAmbient;
}

// Fresnel rim of a glazed surface (u_matExtra.z = strength, Schlick's
// (1 - N.V)^5 rise toward the silhouette): the glaze mirrors the
// environment at grazing angles, white as for any dielectric. Uses the same
// sky gradient as the metals, sharp (a glaze is smooth), scaled by the
// ambient light.
vec3 fresnelRim(vec3 normal)
{
    float k = u_matExtra.z;
    if (k <= 0.0) return vec3(0.0);
    float c = clamp(normal.z, 0.0, 1.0);
    float schlick = pow(1.0 - c, 5.0);
    vec3 r = reflect(vec3(0.0, 0.0, -1.0), normal);
    vec3 sky = mix(ENV_GROUND, ENV_SKY, smoothstep(-0.5, 0.5, r.y));
    return k * schlick * sky * u_lightAmbient;
}

vec4 flight2(in vec3 normal, in vec4 ecPosition, in vec4 in_color)
{
    vec4 color;

    directionalLight2(normal);

    // Intensities: u_lightAmbient = ambient total (0.4 = the former light-model
    // 0.2 + light 0.2), u_lightSpecular = specular x material (0.16 = 0.4 x 0.4).
    // A metal (u_matExtra.x = metalness) scatters little light diffusely,
    // as in the principled BSDF the ray tracer uses: the ambient and diffuse
    // parts drop by (1 - metalness), and the highlight takes part of its
    // colour (the light's own highlight stays near white at its core, as in
    // the ray tracer, where it saturates).
    float metal = clamp(u_matExtra.x, 0.0, 1.0);
    vec3 amb = Ambient.rgb * in_color.rgb * (1.0 - metal);
    vec3 specColor = mix(vec3(1.0), in_color.rgb, 0.5 * metal);
    vec3 rgb = amb + Diffuse.rgb * in_color.rgb * (1.0 - metal) +
               Specular.rgb * specColor + envReflection(normal, in_color.rgb) +
               fresnelRim(normal);
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
    g_ambientFraction = clamp(dot(amb, LUM) / max(dot(rgb, LUM), 1e-4), 0.0, 1.0);
    color = vec4(rgb, in_color.a);
    // An HDR scene target keeps the lit colour; the composite tone maps it.
    // A toon material clips and gamma-encodes instead, as POV-Ray writes its
    // image (assumed_gamma 1.0, an sRGB file): the flat tones then match it.
    if (u_lightNoClamp < 0.5) {
        if (u_matExtra.w > 0.5)
            color = vec4(pow(clamp(color.rgb, 0.0, 1.0), vec3(1.0 / 2.2)), clamp(color.a, 0.0, 1.0));
        else
            color = vec4(toneMap(color.rgb), clamp(color.a, 0.0, 1.0));
    }
    return color;
}
