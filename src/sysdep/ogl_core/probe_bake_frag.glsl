// Ambient probe bake fragment shader (qsys::AmbientProbeVolume).
//
// One fragment per probe. The probe grid (nx, ny, nz) is laid out as a 2D
// atlas with the z slices side by side: texel (x + z * nx, y). The scene depth
// was rendered from u_numDirs directions (orthographic, Fibonacci sphere) into
// the tiles of u_depthAtlas. For each direction the probe is visible when no
// surface lies between it and the light camera, i.e. the stored (nearest)
// depth is not in front of the probe. Output: (m0, m1.xyz) = mean visibility
// and mean visibility-weighted direction.
//
// The direction set and the camera basis must match
// AmbientProbeVolume::probeDir / probeBasis.

uniform sampler2D u_depthAtlas;   // window depth of the u_numDirs light views
uniform vec3 u_center;            // centre of the bounding sphere (world)
uniform float u_radius;           // half extent of each orthographic view
uniform float u_camDist;          // camera distance from the centre
uniform vec2 u_nearFar;           // light camera near / far
uniform int u_tileSize;           // pixels per tile
uniform int u_tilesPerRow;
uniform ivec3 u_dim;              // probe grid size
uniform vec3 u_origin;            // grid corner (texel 0 edge)
uniform float u_spacing;          // probe spacing
uniform float u_depthBias;        // window-depth bias against self-shadowing
uniform int u_numDirs;            // number of directions (tiles)

in vec2 v_uv;

out vec4 o_FragColor;

vec3 probeDir(int k)
{
    float z = 1.0 - (float(k) + 0.5) * 2.0 / float(u_numDirs);
    float r = sqrt(max(0.0, 1.0 - z * z));
    float phi = float(k) * 2.399963229728653;
    return vec3(r * cos(phi), r * sin(phi), z);
}

void main()
{
    ivec2 tc = ivec2(gl_FragCoord.xy);
    int z = tc.x / u_dim.x;
    int x = tc.x - z * u_dim.x;
    int y = tc.y;
    vec3 p = u_origin + (vec3(x, y, z) + 0.5) * u_spacing;

    float m0 = 0.0;
    vec3 m1 = vec3(0.0);
    for (int k = 0; k < u_numDirs; ++k) {
        vec3 d = probeDir(k);
        vec3 up = (abs(d.z) < 0.9) ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        vec3 r = normalize(cross(up, d));
        vec3 u = cross(d, r);
        vec3 q = p - u_center;
        vec2 uv = vec2(dot(q, r), dot(q, u)) / u_radius * 0.5 + 0.5;
        float dist = u_camDist - dot(q, d);
        float depth = (dist - u_nearFar.x) / (u_nearFar.y - u_nearFar.x);
        ivec2 tile = ivec2(k % u_tilesPerRow, k / u_tilesPerRow);
        ivec2 px = tile * u_tileSize +
                   clamp(ivec2(uv * float(u_tileSize)), ivec2(0), ivec2(u_tileSize - 1));
        float stored = texelFetch(u_depthAtlas, px, 0).r;
        if (stored >= depth - u_depthBias) {
            m0 += 1.0;
            m1 += d;
        }
    }
    o_FragColor = vec4(m0, m1) / float(u_numDirs);
}
