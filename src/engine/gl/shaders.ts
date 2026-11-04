// GLSL for the four instanced pipelines plus the background.
//
// The whole scene is drawn with a handful of draw calls: a fullscreen quad for
// the backdrop (gradient, grid, floor, frame — all procedural, so there is no
// per-frame gradient allocation), one instanced quad per circle, one per
// rounded rect, one per textured label, and a triangle soup for the one
// non-rectangular shape. Per-toy detail that used to be a hand-written painter
// branch (bevels, crate braces, brick joints, belt chevrons, glass glints) is a
// `pattern` id the rect shader switches on.
//
// Everything is premultiplied alpha and blended with (ONE, ONE_MINUS_SRC_ALPHA).

/** Fullscreen backdrop. Positions come straight from the quad corner. */
export const BG_VS = `#version 300 es
precision highp float;

in vec2 aCorner;
uniform vec2 uWorld;
out vec2 vWorld;

void main() {
  vWorld = (aCorner * 0.5 + 0.5) * uWorld;
  gl_Position = vec4(aCorner.x, -aCorner.y, 0.0, 1.0);
}`;

export const BG_FS = `#version 300 es
precision highp float;

in vec2 vWorld;
uniform vec2 uWorld;
uniform float uScale;
out vec4 outColor;

// Coverage of a band of half-width halfWidth at distance d, anti-aliased over
// roughly one device pixel.
float band(float d, float halfWidth, float aa) {
  return clamp((halfWidth + aa - d) / (2.0 * aa), 0.0, 1.0);
}

void main() {
  vec2 p = vWorld;
  float w = uWorld.x;
  float h = uWorld.y;

  float t = clamp(p.y / h, 0.0, 1.0);
  vec3 base = t < 0.6
    ? mix(vec3(0.078431, 0.094118, 0.137255), vec3(0.054902, 0.062745, 0.090196), t / 0.6)
    : mix(vec3(0.054902, 0.062745, 0.090196), vec3(0.039216, 0.047059, 0.066667), (t - 0.6) / 0.4);

  // Graph-paper grid, one device pixel wide at 100% and thicker as you zoom out.
  float spacing = 34.0;
  float aa = 0.5 * (fwidth(p.x) + fwidth(p.y));
  float halfW = uScale * 0.5;
  float mx = mod(p.x, spacing);
  float my = mod(p.y, spacing);
  float grid = max(band(min(mx, spacing - mx), halfW, aa), band(min(my, spacing - my), halfW, aa));
  base = mix(base, vec3(1.0), 0.035 * grid);

  // Bottom of the box: a shadow, a lit floor strip, and a hard lip.
  base = mix(base, vec3(0.0), 0.45 * clamp((p.y - (h - 90.0)) / 90.0, 0.0, 1.0));
  base = mix(base, vec3(1.0), 0.06 * clamp((p.y - (h - 26.0)) / 26.0, 0.0, 1.0));
  if (p.y >= h - 2.0 * uScale) base = mix(base, vec3(1.0), 0.11);

  // Inner frame, 2 * scale px in from every edge.
  float edge = min(min(p.x, w - p.x), min(p.y, h - p.y));
  if (edge < 2.0 * uScale) base = mix(base, vec3(1.0), 0.07);

  outColor = vec4(base, 1.0);
}`;

/**
 * One instanced quad per circle: grains, balls, rollers, the spout's falling
 * dots. Per-instance style lives in a second buffer, so the granular layer can
 * be drawn with a single generic vertex attribute instead of 20k records of
 * redundant outline data.
 */
export const CIRCLE_VS = `#version 300 es
precision highp float;

in vec2 aCorner;
in vec2 aPos;
in float aRadius;
in vec4 aColor;
in float aGlow;
in vec4 aBorder;
in float aDash;

uniform vec2 uWorld;

out vec2 vLocal;
flat out float vRadius;
flat out vec4 vColor;
flat out vec4 vBorder;
flat out float vDash;
flat out float vGlow;

void main() {
  float pad = 3.0 + aGlow * 55.0;
  float extent = aRadius + pad;
  vec2 p = aPos + aCorner * extent;
  vec2 clip = p / uWorld * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  vLocal = aCorner * extent;
  vRadius = aRadius;
  vColor = aColor;
  vBorder = aBorder;
  vDash = aDash;
  vGlow = aGlow;
}`;

export const CIRCLE_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
flat in float vRadius;
flat in vec4 vColor;
flat in vec4 vBorder;
flat in float vDash;
flat in float vGlow;
out vec4 outColor;

void main() {
  float r = vRadius;
  float dist = length(vLocal);
  float sdf = dist - r;
  float aa = max(fwidth(dist), 0.0001);
  float inside = clamp((aa - sdf) / (2.0 * aa), 0.0, 1.0);

  // Radial fill lit from the top left — the same stops as the canvas sprite.
  vec2 centre = vec2(-0.35, -0.40) * r;
  float gt = clamp((length(vLocal - centre) - 0.1 * r) / (0.95 * r), 0.0, 1.0);
  vec3 light = mix(vColor.rgb, vec3(1.0), 0.55);
  vec3 deep = mix(vColor.rgb, vec3(0.0), 0.45);
  vec3 fill = gt < 0.55 ? mix(light, vColor.rgb, gt / 0.55) : mix(vColor.rgb, deep, (gt - 0.55) / 0.45);

  // Specular sheen, always top left (a ball never shows its rotation).
  float st = clamp(length(vLocal - vec2(-0.34, -0.40) * r) / (0.6 * r), 0.0, 1.0);
  fill = mix(fill, vec3(1.0), 0.6 * (1.0 - st));

  float outline = 0.0;
  if (vBorder.a > 0.0) {
    outline = clamp((0.75 + aa - abs(sdf)) / (2.0 * aa), 0.0, 1.0) * vBorder.a;
    if (vDash > 0.0) {
      float arc = dist * atan(vLocal.y, vLocal.x);
      outline *= step(0.55 * vDash, mod(arc, vDash));
    }
  }

  float glow = 0.0;
  if (vGlow > 0.0) {
    glow = vGlow * 0.55 * exp(-max(sdf, 0.0) * 0.08) * (1.0 - inside);
  }

  vec3 rgb = vColor.rgb * glow;
  float a = glow;

  float fa = inside * vColor.a;
  rgb = rgb * (1.0 - fa) + fill * fa;
  a = a * (1.0 - fa) + fa;

  rgb = rgb * (1.0 - outline) + vBorder.rgb * outline;
  a = a * (1.0 - outline) + outline;

  if (a <= 0.002) discard;
  outColor = vec4(rgb, a);
}`;

/** One instanced quad per rounded rect: blocks, belts, notes, spouts, shards. */
export const RECT_VS = `#version 300 es
precision highp float;

in vec2 aCorner;
in vec2 aPos;
in vec2 aHalf;
in float aRadius;
in float aAngle;
in vec4 aColor;
in vec2 aShade;
in vec4 aBorder;
in float aBorderW;
in float aPattern;
in vec2 aParam;
in vec3 aPatternRgb;
in float aGlow;

uniform vec2 uWorld;

out vec2 vLocal;
flat out vec2 vHalf;
flat out float vRadius;
flat out vec4 vColor;
flat out vec2 vShade;
flat out vec4 vBorder;
flat out float vBorderW;
flat out float vPattern;
flat out vec2 vParam;
flat out vec3 vPatternRgb;
flat out float vGlow;

void main() {
  float pad = 2.0 + aGlow * 55.0;
  vec2 local = aCorner * (aHalf + pad);
  float s = sin(aAngle);
  float c = cos(aAngle);
  vec2 p = aPos + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = p / uWorld * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  vLocal = local;
  vHalf = aHalf;
  vRadius = aRadius;
  vColor = aColor;
  vShade = aShade;
  vBorder = aBorder;
  vBorderW = aBorderW;
  vPattern = aPattern;
  vParam = aParam;
  vPatternRgb = aPatternRgb;
  vGlow = aGlow;
}`;

export const RECT_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
flat in vec2 vHalf;
flat in float vRadius;
flat in vec4 vColor;
flat in vec2 vShade;
flat in vec4 vBorder;
flat in float vBorderW;
flat in float vPattern;
flat in vec2 vParam;
flat in vec3 vPatternRgb;
flat in float vGlow;
out vec4 outColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * t);
}

vec3 tint(vec3 base, float amount) {
  return amount < 0.0 ? mix(base, vec3(0.0), -amount) : mix(base, vec3(1.0), amount);
}

void main() {
  vec2 p = vLocal;
  float r = min(vRadius, min(vHalf.x, vHalf.y));
  float d = sdRoundBox(p, vHalf, r);
  float aa = max(fwidth(d), 0.0001);
  float inside = clamp((aa - d) / (2.0 * aa), 0.0, 1.0);

  // Vertical gradient, in the body's own frame, so it turns with the block.
  float gt = clamp(p.y / max(2.0 * vHalf.y, 0.0001) + 0.5, 0.0, 1.0);
  vec3 fill = mix(tint(vColor.rgb, vShade.x), tint(vColor.rgb, vShade.y), gt);

  int pattern = int(vPattern + 0.5);
  float detail = 0.0;
  vec3 detailRgb = vPatternRgb;

  if (pattern == 1) {
    // Bevel: a light stroke inset from the edge.
    float dd = abs(sdRoundBox(p, vHalf - 1.5, max(r - 1.5, 0.0)));
    detail = clamp((0.5 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.22;
    detailRgb = vec3(1.0);
  } else if (pattern == 2) {
    // Crate: a cross brace between the corners.
    float inset = min(vHalf.x, vHalf.y) * 0.32;
    float dd = min(
      sdSegment(p, vec2(-vHalf.x + inset, -vHalf.y + inset), vec2(vHalf.x - inset, vHalf.y - inset)),
      sdSegment(p, vec2(vHalf.x - inset, -vHalf.y + inset), vec2(-vHalf.x + inset, vHalf.y - inset))
    );
    detail = clamp((0.75 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.22;
    detailRgb = vec3(0.0);
  } else if (pattern == 3) {
    float dd = abs(p.y);
    detail = clamp((0.75 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.22 * step(abs(p.x), vHalf.x - 3.0);
    detailRgb = vec3(0.0);
  } else if (pattern == 4) {
    float dd = abs(p.y + vHalf.y * 0.36);
    detail = clamp((0.5 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.22 * step(abs(p.x), vHalf.x - 4.0);
    detailRgb = vec3(0.0);
  } else if (pattern == 5) {
    // Two diagonal glints across the pane.
    float dd = min(
      sdSegment(p, vec2(-vHalf.x * 0.2, -vHalf.y * 1.2), vec2(-vHalf.x * 1.1, vHalf.y * 0.2)),
      sdSegment(p, vec2(vHalf.x * 0.24, -vHalf.y * 1.2), vec2(-vHalf.x * 0.6, vHalf.y * 0.1))
    );
    detail = clamp((1.9 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.45;
    detailRgb = vec3(1.0);
  } else if (pattern == 6) {
    // Belt: chevrons sliding along the body.
    float spacing = 30.0;
    float dir = vParam.y >= 0.0 ? 1.0 : -1.0;
    float u = mod(p.x - vParam.x + spacing * 0.5, spacing) - spacing * 0.5;
    float span = u * dir;
    // Each arm reaches out and back: the signed y of the upper arm is negative,
    // so mirror it before comparing against |p.y|.
    float arm = abs(0.06 * vHalf.y * (u - 3.0 * dir) / dir);
    float dd = abs(abs(p.y) - arm);
    float on = step(-5.0, span) * step(span, 3.0);
    detail = clamp((1.25 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.8 * on;
  } else if (pattern == 7) {
    float dd = abs(sdRoundBox(p, vHalf - 2.0, max(r - 1.0, 0.0)));
    detail = clamp((0.5 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.3;
    detailRgb = vec3(1.0);
  } else if (pattern == 8) {
    float dd = abs(sdRoundBox(p, vHalf - 3.0, max(r - 2.0, 0.0)));
    detail = clamp((0.5 + aa - dd) / (2.0 * aa), 0.0, 1.0) * 0.5;
  }

  float ring = 0.0;
  if (vBorder.a > 0.0 && vBorderW > 0.0) {
    float inner = clamp((aa - sdRoundBox(p, vHalf - vBorderW, max(r - vBorderW, 0.0))) / (2.0 * aa), 0.0, 1.0);
    ring = inside * (1.0 - inner) * vBorder.a;
    if (pattern == 9) {
      // Dashed preview outline: arc length approximated by the Manhattan
      // distance from the centre, which is monotonic along every straight edge.
      float arc = abs(p.x) + abs(p.y) + vParam.x * 0.5;
      ring *= step(0.55 * vParam.x, mod(arc, vParam.x));
    }
  }

  float glow = 0.0;
  if (vGlow > 0.0) {
    glow = vGlow * 0.5 * exp(-max(d, 0.0) * 0.08) * (1.0 - inside);
  }

  vec3 rgb = vColor.rgb * glow;
  float a = glow;

  float fa = inside * vColor.a;
  rgb = rgb * (1.0 - fa) + fill * fa;
  a = a * (1.0 - fa) + fa;

  if (detail > 0.0) {
    rgb = rgb * (1.0 - detail) + detailRgb * detail;
    a = a * (1.0 - detail) + detail;
  }

  rgb = rgb * (1.0 - ring) + vBorder.rgb * ring;
  a = a * (1.0 - ring) + ring;

  if (a <= 0.002) discard;
  outColor = vec4(rgb, a);
}`;

/** Textured label quad — the note names from the atlas. */
export const SPRITE_VS = `#version 300 es
precision highp float;

in vec2 aCorner;
in vec2 aPos;
in vec2 aHalf;
in float aAngle;
in vec4 aUV;

uniform vec2 uWorld;

out vec2 vUV;

void main() {
  vec2 local = aCorner * aHalf;
  float s = sin(aAngle);
  float c = cos(aAngle);
  vec2 p = aPos + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = p / uWorld * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  // Corner (-1,-1) is the top-left of the body: v0 is the top of the cell.
  vUV = vec2(mix(aUV.x, aUV.z, aCorner.x * 0.5 + 0.5), mix(aUV.y, aUV.w, aCorner.y * 0.5 + 0.5));
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uLabels;
out vec4 outColor;

void main() {
  outColor = texture(uLabels, vUV);
}`;

/** Non-rectangular bodies: a triangle soup with per-vertex colour. */
export const POLY_VS = `#version 300 es
precision highp float;

in vec2 aPos;
in vec4 aColor;

uniform vec2 uWorld;

out vec4 vColor;

void main() {
  vec2 clip = aPos / uWorld * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vColor = aColor;
}`;

export const POLY_FS = `#version 300 es
precision highp float;

in vec4 vColor;
out vec4 outColor;

void main() {
  if (vColor.a <= 0.002) discard;
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;
