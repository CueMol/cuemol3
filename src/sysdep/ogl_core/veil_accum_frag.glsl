// Veil accumulation fragment shader (frame pipeline veil composite).
//
// One veil, drawn opaque into u_veilTex (alpha > 0 where it covers the
// pixel), is added into the float accumulation targets with an additive
// blend (ONE, ONE); pixels it does not cover are discarded.
//   u_mode 0: (a * S, a)      -> sum of a_i * S_i and of a_i
//   u_mode 1: (-log(1 - a))   -> sum of -log(1 - a_i), the transmittance
//                                T = prod(1 - a_i) = exp(-sum) (one blend
//                                mode for both targets: the blend function is
//                                common to all draw targets)
// a is the veil's alpha (u_alpha); veils are below 1, so the log is finite.

uniform sampler2D u_veilTex;
uniform float u_alpha;
uniform int u_mode;

in vec2 v_uv;

out vec4 o_FragColor;

void main()
{
    vec4 s = texture(u_veilTex, v_uv);
    if (s.a <= 0.0) discard;
    if (u_mode == 0)
        o_FragColor = vec4(u_alpha * s.rgb, u_alpha);
    else
        o_FragColor = vec4(-log(1.0 - u_alpha), 0.0, 0.0, 0.0);
}
