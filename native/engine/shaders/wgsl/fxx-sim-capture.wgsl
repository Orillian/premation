// X2: the layer at the simulation's start (tex0, a time tap in buffer space)
// captured into a SIM slot over the layer box.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return at0(pxUv(uv * lwh()));
}
