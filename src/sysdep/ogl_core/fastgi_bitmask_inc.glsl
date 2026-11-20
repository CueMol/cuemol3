// -*-Mode: C++;-*-
//
// Visibility bitmask operations of the Fast GI AO (gtao_frag.glsl), from
// Blender EEVEE Next fast_gi (eevee_fast_gi.bsl.hh; Therrien et al., "Screen
// Space Indirect Lighting with Visibility Bitmask"). Pure functions of their
// arguments: they read no uniform. The including shader must define the
// constant PI before the include.
//

#pragma once

uint popcount32(uint v)
{
    v = v - ((v >> 1u) & 0x55555555u);
    v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
    v = (v + (v >> 4u)) & 0x0F0F0F0Fu;
    return (v * 0x01010101u) >> 24u;
}

uint anglesToBitmask(vec2 theta)
{
    vec2 ratio = clamp(theta * (1.0 / PI) + 0.5, 0.0, 1.0);
    uint a = uint(floor(32.0 * ratio.x));
    uint b = uint(ceil(32.0 * (ratio.y - ratio.x)));
    if (a >= 32u) return 0u;
    return (((b < 32u) ? (1u << b) : 0u) - 1u) << a;
}

float bitmaskToVisibilityCosine(uint m)
{
    const vec4 weights = vec4(0.0095061, 0.0270951, 0.0405571, 0.0478421);
    vec4 c = vec4(float(popcount32(m & 0xF000000Fu)), float(popcount32(m & 0x0F0000F0u)),
                  float(popcount32(m & 0x00F00F00u)), float(popcount32(m & 0x000FF000u)));
    return clamp(1.0 - dot(c, weights), 0.0, 1.0);
}
