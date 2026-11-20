// -*-Mode: C++;-*-
//
// Tone curve from the lit colour to the [0, 1] output, in place of a clamp at
// 1. A clamp flattens everything above 1, so on a light colour (a white
// surface) the lit face and its highlight both clip and the highlight
// vanishes. This curve is the identity up to the knee, then a cubic shoulder
// that reaches 1 at the white point with zero slope (C1 at both ends): the
// bright end keeps its gradation, compressed, and the brightest highlight
// still reaches pure white. The white point covers the brightest lit white
// (ambient + diffuse + specular, about 1.36 with Fast GI and 1.48 without).
// Applied once per pixel where the lit colour leaves the HDR range: the end
// of the Fast GI composite (ao_composite_frag.glsl) or, for an LDR scene
// target, the lighting itself (lighting_inc.glsl flight2).
//

#pragma once

// Linear below this value; the colours below it keep their exact value.
const float TONE_KNEE = 0.7;
// Input that maps to 1.
const float TONE_WHITE = 1.5;

vec3 toneMap(vec3 x)
{
    // Hermite shoulder on t = (x - knee) / (white - knee): s(0) = 0,
    // s(1) = 1, s'(1) = 0, and s'(0) = m so that the slope at the knee is 1.
    // Monotonic for m <= 3 (white - knee <= 3 (1 - knee)).
    const float m = (TONE_WHITE - TONE_KNEE) / (1.0 - TONE_KNEE);
    vec3 t = clamp((x - vec3(TONE_KNEE)) / (TONE_WHITE - TONE_KNEE), 0.0, 1.0);
    vec3 s = t * (m + t * ((3.0 - 2.0 * m) + t * (m - 2.0)));
    vec3 shoulder = vec3(TONE_KNEE) + (1.0 - TONE_KNEE) * s;
    return clamp(mix(x, shoulder, step(vec3(TONE_KNEE), x)), 0.0, 1.0);
}
