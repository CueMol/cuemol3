// Veil composite fragment shader (frame pipeline veil composite).
//
// Composites the accumulated veils over the background B already in the
// bound target, per pixel as the ray tracer's PerPixel group blend:
//   T   = prod(1 - a_i) = exp(-u_logTex.r)    background weight
//   out = T * B + (1 - T) * sum(a_i S_i) / sum(a_i)
// The background is not read here (it is the target being written): this
// pass outputs (sum(a_i S_i) / sum(a_i), 1 - T) and the blend
// (DisplayContext::setBlendModeVeil: colour SRC_ALPHA / ONE_MINUS_SRC_ALPHA,
// alpha ONE / ONE_MINUS_SRC_ALPHA) forms the colour above and the coverage
// (1 - T) + T * B.a. Pixels no veil covers are discarded and keep B.

uniform sampler2D u_accTex;  // rgb = sum(a_i S_i), a = sum(a_i)
uniform sampler2D u_logTex;  // r = sum(-log(1 - a_i))

in vec2 v_uv;

out vec4 o_FragColor;

void main()
{
    vec4 acc = texture(u_accTex, v_uv);
    if (acc.a <= 0.0) discard;
    float T = exp(-texture(u_logTex, v_uv).r);
    o_FragColor = vec4(acc.rgb / acc.a, 1.0 - T);
}
