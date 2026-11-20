// Temporal-jitter compose fragment shader.
//
// Used by both the accumulate and the display steps of the temporal jitter
// supersampling path:
//   accumulate: additive blend (ONE,ONE), u_weight = 1/N, src = the per-sample
//               3D color -> the float accumulation target sums sample/N.
//   display:    no blend, u_weight = N/(sampleCount), src = the accumulation
//               target -> normalizes the partial sum to an average for output.

uniform sampler2D u_colorTex;
uniform float u_weight;
// 1 = divide the colour by its alpha (an export with a transparent
// background resolves its premultiplied colour this way).
uniform int u_unpremul;

in vec2 v_uv;

out vec4 o_FragColor;

void main()
{
    vec4 c = texture(u_colorTex, v_uv) * u_weight;
    if (u_unpremul != 0) c.rgb = (c.a > 0.0) ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
    o_FragColor = c;
}
