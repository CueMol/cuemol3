// Ambient probe fill fragment shader (qsys::AmbientProbeVolume).
//
// A probe inside an atom sees nothing (m0 == 0). Replace such a probe by the
// mean of its valid 26 neighbours, so the trilinear lookup near a surface does
// not pull in the black interior (Blender rejects such probes and flood-fills
// them). Run a few times, ping-ponging between two atlases.

uniform sampler2D u_src;      // probe atlas: texel (x + z * nx, y)
uniform ivec3 u_dim;

in vec2 v_uv;

out vec4 o_FragColor;

const float INVALID = 1e-4;

void main()
{
    ivec2 tc = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(u_src, tc, 0);
    if (c.x > INVALID) {
        o_FragColor = c;
        return;
    }
    int z = tc.x / u_dim.x;
    int x = tc.x - z * u_dim.x;
    int y = tc.y;
    vec4 acc = vec4(0.0);
    float cnt = 0.0;
    for (int dz = -1; dz <= 1; ++dz) {
        for (int dy = -1; dy <= 1; ++dy) {
            for (int dx = -1; dx <= 1; ++dx) {
                ivec3 g = ivec3(x + dx, y + dy, z + dz);
                if (any(lessThan(g, ivec3(0))) || any(greaterThanEqual(g, u_dim))) continue;
                vec4 s = texelFetch(u_src, ivec2(g.x + g.z * u_dim.x, g.y), 0);
                if (s.x <= INVALID) continue;
                acc += s;
                cnt += 1.0;
            }
        }
    }
    o_FragColor = (cnt > 0.0) ? acc / cnt : c;
}
