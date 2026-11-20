#==============================================================================
# GLSL shaders of the ogl_core backend
#
# Shared by the sysdep target (sysdep/CMakeLists.txt) and by the CLI
# configuration, which does not build sysdep (see ../CMakeLists.txt): the
# tritium Electron renderer (ElecDisplayContext) reads the preprocessed
# shaders from share/data/shaders at run time on every platform.
# Paths are absolute so that the lists can be used from any directory.
#==============================================================================

SET(OGL_CORE_SHADER_SOURCES
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trig_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trig_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trigedge_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trigedge_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/pixdraw_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/pixdraw_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew2_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew2idx_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linevalidx_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trig_pick_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/trig_pick_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew2_pick_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew_pick_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew2idx_pick_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linevalidx_pick_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/postproc_vert.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/depthvis_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/ao_composite_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/gtao_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/ao_denoise_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/probe_bake_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/probe_fill_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/fxaa_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/smaa_edges_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/smaa_weights_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/smaa_blend_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/jitter_compose_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/hover_mask_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/hover_blur_frag.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/hover_hl_frag.glsl
)
SET(OGL_CORE_SHADER_DEPS
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/lighting_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/fog_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/matrices_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/linew_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/lib_atoms.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/pick_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/fastgi_bitmask_inc.glsl
  ${CMAKE_CURRENT_LIST_DIR}/ogl_core/tonemap_inc.glsl
)
