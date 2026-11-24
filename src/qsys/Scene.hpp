// -*-Mode: C++;-*-
//
// Scene: root object of the document
//

#ifndef QSYS_SCENE_HPP_INCLUDED
#define QSYS_SCENE_HPP_INCLUDED

#include "qsys.hpp"

#include <qlib/LScrObjects.hpp>
#include <qlib/LScrSmartPtr.hpp>
#include <qlib/ObjectManager.hpp>
#include <qlib/LScrCallBack.hpp>
#include <qlib/LPropEvent.hpp>

// #include <gfx/AbstractColor.hpp>
// #include <gfx/CmsXform.hpp>

#include "Object.hpp"
#include "ObjectEvent.hpp"
#include "View.hpp"
#include "Camera.hpp"
#include "UndoManager.hpp"
#include "SceneAppData.hpp"

#include <qlib/LDOM2Tree.hpp>

#include <map>
#include <memory>
#include <vector>

class Scene_wrap;

namespace qlib {
  class InStream;
  class OutStream;
  class LByteArray;
}

namespace gfx {
  class DisplayContext;
}

// interpreter bound to this scene
namespace jsbr {
  class Interp;
}

using qlib::LString;

namespace qsys {

  class SceneEventCaster;
  class SceneEventListener;
  class SceneEvent;
  class ObjLoadEditInfo;
  class StyleMgr;
  class AnimMgr;

  class QSYS_API Scene :
    public qlib::LNoCopyScrObject,
    public qlib::LUIDObject,
    public qlib::LPropEventListener,
    public ObjectEventListener,
    public RendererEventListener
  {
    MC_SCRIPTABLE;

    friend class ObjLoadEditInfo;
    friend class ::Scene_wrap;
    
    ////////////////////////////////////////////////////////////
    // Typedefs

  private:
    typedef std::map<qlib::uid_t, ObjectPtr> data_t;

    typedef std::map<qlib::uid_t, RendererPtr> rendtab_t;

    typedef std::map<qlib::uid_t, ViewPtr> viewtab_t;

    typedef std::map<LString, CameraPtr> camtab_t;

    typedef qlib::LNoCopyScrObject super_t;
    // typedef qlib::LSimpleCopyScrObject super_t;

  public:
    typedef data_t::const_iterator ObjIter;
    typedef viewtab_t::const_iterator ViewIter;
    typedef camtab_t::const_iterator CameraIter;
    
    ////////////////////////////////////////////////////////////
    // Implementation: Data

  private:

    /// Name of this scene
    LString m_name;

    /// Source of this scene
    ///  (currently only supports local path name)
    LString m_source;
    LString m_sourceType;

    /// Background color
    gfx::ColorPtr m_pBgColor;

    /// Screen-space ambient occlusion (GTAO) enable flag
    bool m_bAOEnabled;

    /// GTAO occlusion sphere radius in view-space (world) units
    double m_fAORadius;

    /// GTAO contrast: occlusion = pow(occlusion, aoIntensity)
    double m_fAOIntensity;

    /// GTAO number of horizon slices (higher = smoother, slower)
    int m_nAOSlices;

    /// GTAO number of steps marched per slice (radial samples)
    int m_nAOSteps;

    /// Compute the GTAO term at half resolution (edge-aware upsample on composite)
    bool m_bAOHalfRes;

    /// AO integration method, Fast GI indirect light and probe strength
    /// (see Scene.qif)
    int m_nAOMethod;
    double m_fAOBounce;
    double m_fAOProbeStrength;
    double m_fLightBrightness;

    /// AO debug view (see AODebugView; not saved)
    int m_nAODebugView;

    /// Log per-pass frame pipeline times (not saved)
    bool m_bRenderTiming;

    /// Counts the changes that can alter the drawn geometry (see
    /// notifyOccluderChanged); the ambient probes rebake when it moves.
    unsigned int m_nOccluderGen = 0;

    /// Post-process anti-aliasing method (see AAMethod enum below)
    int m_nAAMethod;

    /// Temporal jitter supersampling level (0 = off, 1..5 = 2/4/8/16/32 samples)
    int m_nAAJitterLevel;

    /// SMAA edge-detection threshold (max RGB delta between neighbor pixels)
    double m_fAASmaaThreshold;

    /// UID of this scene
    qlib::uid_t m_nUID;

    /// script event handler: onload
    LString m_scrOnLoadEvent;

    ////////////////////////////////////////////////////////////

    /// Objects in this scene
    data_t m_data;

    /// Renderers in this scene
    rendtab_t m_rendtab;

    /// Views for this scene
    viewtab_t m_viewtab;

    /// Cameras in this scene
    camtab_t m_camtab;

    /// Scene event management
    SceneEventCaster *m_pEvtCaster;

    /// Undo/Redo manager for this scene
    UndoManager m_undomgr;

    /// Cached style mgr ptr
    StyleMgr *m_pStyleMgr;

    /// Interpreter context for this scene
    jsbr::Interp *m_pInterp;

    /// Scene loading flag : true when scene is loading from storage
    ///  (used to avoid event generation on the loading phase)
    bool m_bLoading;

  public:

    ////////////////////////////////////////////////////////////

    /// constructor
    Scene();

    /// destructor
    ~Scene() override;

    /// initialization
    void init();

    ////////////////////////////////////////////////////////////
    // Properties

    /// Name of the scene (read only from UI)
    const LString &getName() const { return m_name; }
    void setName(const LString &name);
  
    /// Get modified flag
    bool isModified() const;

    /// check if the scene is just created and empty
    bool isJustCreated() const;

    /// Get UID of this scene (readonly)
    qlib::uid_t getUID() const { return m_nUID; }

    const gfx::ColorPtr &getBgColor() const { return m_pBgColor; }
    void setBgColor(const gfx::ColorPtr &r) {
      setUpdateFlag();
      m_pBgColor = r;
    }

    /// Screen-space ambient occlusion (GTAO) enable flag
    bool isAOEnabled() const { return m_bAOEnabled; }
    void setAOEnabled(bool b) {
      setUpdateFlag();
      m_bAOEnabled = b;
    }

    /// GTAO occlusion sphere radius (view-space / world units)
    double getAORadius() const { return m_fAORadius; }
    void setAORadius(double v) {
      setUpdateFlag();
      m_fAORadius = v;
    }

    /// GTAO contrast (occlusion = pow(occlusion, aoIntensity))
    double getAOIntensity() const { return m_fAOIntensity; }
    void setAOIntensity(double v) {
      setUpdateFlag();
      m_fAOIntensity = v;
    }

    /// GTAO number of horizon slices
    int getAOSlices() const { return m_nAOSlices; }
    void setAOSlices(int v) {
      setUpdateFlag();
      m_nAOSlices = v;
    }

    /// GTAO number of steps marched per slice
    int getAOSteps() const { return m_nAOSteps; }
    void setAOSteps(int v) {
      setUpdateFlag();
      m_nAOSteps = v;
    }

    /// Compute the GTAO term at half resolution (load reduction)
    bool isAOHalfRes() const { return m_bAOHalfRes; }
    void setAOHalfRes(bool v) {
      setUpdateFlag();
      m_bAOHalfRes = v;
    }

    /// AO integration methods (match the aoMethod enumdef).
    enum AOMethod {
      AOM_GTAO = 0,
      AOM_FASTGI = 1,
    };

    /// Ambient total and diffuse light while the Fast GI AO is on, for the
    /// material "default" (other materials are scaled alike,
    /// getMaterialLight). The AO darkens the ambient part; the diffuse key
    /// light tells the faces of a shape apart (a cartoon cylinder's side from
    /// its cap) and is darkened in the cavities by its probe shadow, so a
    /// strong key does not light the cavities up. Without Fast GI the scene
    /// keeps the former 0.4 / 0.8 (kLegacyLight*), which shade without AO.
    /// Both are scaled by lightBrightness.
    /// (ambient / diffuse 0.7 / 0.65 tuned for the depth cue, x 0.8 for the
    /// brightness). The specular light and exponent are not scaled: they are
    /// the material's in every AO mode, so that a material keeps its
    /// character (plastic, metal) when the mode changes.
    static constexpr double kFastGILightAmbient = 0.56;
    static constexpr double kFastGILightDiffuse = 0.52;
    /// Extra brightness while the Fast GI AO is on, multiplied into
    /// lightBrightness for the ambient, diffuse and specular alike (as if the
    /// Brightness knob read 1.32 times higher). The AO darkens the ambient part,
    /// so at the same knob Fast GI looked darker than GTAO / no AO. Kept out
    /// of the knob's default so that GTAO / no AO and older files keep their
    /// brightness. Materials lit by the ambient light alone get no AO and no
    /// boost (getMaterialLight).
    static constexpr double kFastGILightBrightness = 1.32;
    /// The former ambient total / diffuse light without Fast GI, for the
    /// material "default".
    static constexpr double kLegacyLightAmbient = 0.4;
    static constexpr double kLegacyLightDiffuse = 0.8;
    /// Values of the material "default" (data/default_style.xml), also used
    /// for a material name no style defines: matte plastic (the material
    /// "matte_plastic"), a weak broad white highlight (specular 0.3 x the
    /// light's 0.4 = 0.12, exponent 16) on a diffuse-dominant colour. Polished
    /// plastic ("plastic", exponent 76.8) shines too much for a default.
    static constexpr double kDefaultMaterialAmbient = 0.2;
    static constexpr double kDefaultMaterialDiffuse = 0.8;
    static constexpr double kDefaultMaterialSpecular = 0.3;
    static constexpr double kDefaultMaterialShininess = 16.0;
    /// Diffuse light of a toon material: the total light of CueMol's POV-Ray
    /// export (_light_inten 1.3: key light 0.5 + flash light 0.8, split
    /// between them in lighting_inc.glsl), so the view matches POV-Ray.
    static constexpr double kToonLightDiffuse = 1.3;
    /// Eye-space direction to the key light (upper right front), the same
    /// with and without Fast GI.
    static constexpr float kLightDir[3] = {1.0f, 1.0f, 1.5f};
    /// Fast GI: contrast (power of the visibility) of the key light's soft
    /// shadow from the baked probes (gtao_frag.glsl).
    static constexpr double kFastGIKeyShadowPower = 2.0;

    /// Light intensities, specular exponent and the extra terms (FogBlock)
    /// of one material.
    struct MaterialLight
    {
      float ambient;
      float diffuse;
      float specular;
      float shininess;
      /// Metalness 0-1, toon (1 = flat tones, 0 = smooth), Fresnel rim 0-1
      /// (gfx::Material::MAT_METALLIC / MAT_TOON / MAT_FRESNEL).
      float metallic = 0.0f;
      float toon = 0.0f;
      float fresnel = 0.0f;
      /// 1 = light the toon as POV-Ray renders its finish (without AO only).
      float toonPov = 0.0f;
    };

    /// The light a renderer of material mat_id is lit with: the material's
    /// values (data/default_style.xml, as CueMol2's OpenGL view read them),
    /// scaled for the AO method and by lightBrightness. An empty name takes
    /// the material "default"; an unknown name is lit as before materials
    /// took effect.
    MaterialLight getMaterialLight(const LString &mat_id) const;

    ////////////////////////////////////////////////////////////
    // Translucent renderers composited as veils (frame pipeline)

    /// A renderer whose alpha is below 1 - kVeilAlphaEps is a veil: the
    /// frame pipeline draws it opaque in a pass of its own and composites
    /// the passes per pixel, as the ray tracer (umbreon) does. Alphas within
    /// kVeilAlphaEps of a veil's form that veil.
    static constexpr double kVeilAlphaEps = 1e-4;

    /// Group renderer alphas into veils, in order of first appearance (the
    /// ray tracer's bucketVeils): veilIdx[i] is the veil of alphas[i], or -1
    /// for an opaque renderer; veilAlphas[v] is veil v's alpha (its first
    /// member's).
    static void assignVeils(const std::vector<double> &alphas, std::vector<int> &veilIdx,
                            std::vector<double> &veilAlphas);

    /// What display() draws.
    struct DrawFilter
    {
      enum Kind {
        /// Everything (no veil composite).
        DF_ALL = 0,
        /// All but the veils and the labels drawn on top.
        DF_BACKGROUND,
        /// One veil (veil = its index), opaque (alpha 1), without labels.
        DF_VEIL,
        /// Only the labels drawn on top (Renderer::isLabelOnTop).
        DF_ONTOP_LABELS,
      };
      Kind kind = DF_ALL;
      int veil = -1;
    };

    /// The filter of the next display() calls (the frame pipeline sets it
    /// around its scene draws, see AutoDrawFilter).
    void setDrawFilter(const DrawFilter &f) { m_drawFilter = f; }
    const DrawFilter &getDrawFilter() const { return m_drawFilter; }

    /// The alphas of the veils of the visible renderers (index = veil).
    std::vector<double> getVeilAlphas() const;

    /// Restores the draw filter on scope exit.
    class AutoDrawFilter
    {
    public:
      AutoDrawFilter(Scene *pScene, const DrawFilter &f) : m_pScene(pScene), m_saved(pScene->getDrawFilter())
      {
        m_pScene->setDrawFilter(f);
      }
      ~AutoDrawFilter() { m_pScene->setDrawFilter(m_saved); }

    private:
      Scene *m_pScene;
      DrawFilter m_saved;
    };

  private:
    /// The filter of display() (DrawFilter).
    DrawFilter m_drawFilter;

  public:

    /// Overall light scale (lightBrightness): multiplies the ambient, diffuse
    /// and specular intensities alike, so the image gets brighter or darker
    /// while the shading ratios (the depth cue of the AO) stay the same.
    double getLightBrightness() const { return m_fLightBrightness; }
    void setLightBrightness(double v) {
      if (m_fLightBrightness == v) return;
      m_fLightBrightness = v;
      setUpdateFlag();
    }

    /// AO debug view values (match the aoDebugView enumdef).
    enum AODebugView {
      AODV_OFF = 0,
      AODV_AO = 1,
      AODV_NORMAL = 2,
      AODV_DEPTH = 3,
    };

    /// AO integration method (AOMethod, see Scene.qif)
    int getAOMethod() const { return m_nAOMethod; }
    void setAOMethod(int v) {
      if (m_nAOMethod == v) return;
      m_nAOMethod = v;
      setUpdateFlag();
    }
    /// Fast GI: strength of the baked ambient probes (0 = no bake)
    double getAOProbeStrength() const { return m_fAOProbeStrength; }
    void setAOProbeStrength(double v) {
      if (m_fAOProbeStrength == v) return;
      m_fAOProbeStrength = v;
      setUpdateFlag();
    }
    /// Fast GI: strength of the near-field indirect light (0 = AO only)
    double getAOBounce() const { return m_fAOBounce; }
    void setAOBounce(double v) {
      if (m_fAOBounce == v) return;
      m_fAOBounce = v;
      setUpdateFlag();
    }

    /// Debug view of the AO stage (not saved)
    int getAODebugView() const { return m_nAODebugView; }
    void setAODebugView(int v) {
      setUpdateFlag();
      m_nAODebugView = v;
    }

    /// The drawn geometry may have changed: atoms moved or were added or
    /// removed, an object or renderer was added, removed, shown, hidden or
    /// edited. Called from the object / renderer / scene event dispatch and
    /// from the renderers' display cache invalidation, so a camera move alone
    /// never calls it. AmbientProbeVolume rebakes when the count moves.
    void notifyOccluderChanged() { ++m_nOccluderGen; }
    unsigned int getOccluderGen() const { return m_nOccluderGen; }

    /// Log per-pass frame pipeline times (not saved)
    bool isRenderTiming() const { return m_bRenderTiming; }
    void setRenderTiming(bool v) {
      setUpdateFlag();
      m_bRenderTiming = v;
    }

    /// Post-process anti-aliasing method values (match the aa_method enumdef).
    enum AAMethod {
      AA_NONE = 0,
      AA_FXAA = 1,
      AA_SMAA = 2,
    };

    /// Post-process anti-aliasing method applied after the composite stage of
    /// the frame pipeline (independent of the AO setting).
    int getAAMethod() const { return m_nAAMethod; }
    void setAAMethod(int v) {
      setUpdateFlag();
      m_nAAMethod = v;
    }

    /// Temporal jitter supersampling level (0 = off, 1..5 = 2/4/8/16/32 samples).
    int getAAJitterLevel() const { return m_nAAJitterLevel; }
    void setAAJitterLevel(int v) {
      setUpdateFlag();
      m_nAAJitterLevel = v;
    }

    /// SMAA edge-detection threshold. Lower = more edges antialiased.
    double getAASmaaThreshold() const { return m_fAASmaaThreshold; }
    void setAASmaaThreshold(double v) {
      setUpdateFlag();
      m_fAASmaaThreshold = v;
    }

    /// True when the scene requires the off-screen frame pipeline (AO,
    /// spatial post-AA, temporal jitter, or a translucent renderer, whose
    /// veil the pipeline composites); false = direct rendering suffices. Any
    /// one of them routes the frame through the pipeline.
    bool requiresFramePipeline() const {
      return m_bAOEnabled || m_nAAMethod != AA_NONE || m_nAAJitterLevel > 0 ||
             !getVeilAlphas().empty();
    }

    /// get source path of this scene
    const LString &getSource() const {
      return m_source;
    }
    /// set source path of this scene
    void setSource(const LString &name);

    /// get source path of this scene
    const LString &getSourceType() const {
      return m_sourceType;
    }
    /// set source path of this scene
    void setSourceType(const LString &name) {
      m_sourceType = name;
    }

    /// Return the base path for this scene (directory containing source file)
    LString getBasePath() const;
    /// Resolve relative path name using base_path of this scene
    LString resolveBasePath(const LString &aLocalFile) const;

    /// Convert rel and abs of src and alt_src paths
    std::pair<LString, LString> convSrcPaths(const LString &aSrc,
                                             const LString &aAltSrc) const;
    
    /// Convert rel and abs of src and alt_src paths
    /// This method calls convSrcPaths() and additionary append src and alt_src attributes to pNode.
    std::pair<LString, LString> setPathsToNode(const LString &aSrc,
                                               const LString &aAltSrc,
                                               qlib::LDom2Node *pNode) const;

    ////////////////////////////////////////////////////////////
    // Script interpreter operations

    jsbr::Interp *getInterp() const { return m_pInterp; }

    bool execJSFile(const LString &scr);

    ////////////////////////////////////////////////////////////
    // Object manager

    /// Add a new object to this scene
    ///  (object should not belong to any scene.)
    bool addObject(ObjectPtr pobj);

    /// Destroy object by UID
    bool destroyObject(qlib::uid_t uid);
    /// Destroy all objects
    void destroyAllObjects();

    /// Get object by UID
    ObjectPtr getObject(qlib::uid_t uid) const;
    /// Get (first) object by name, of any type
    ObjectPtr getObjectByName(const LString &name) const;

    /// Every object of this name, in UID order (impl: Scene.cpp)
    std::vector<ObjectPtr> getObjectsByName(const LString &name) const;

    /// The first object of this name (in UID order) that is a T: another
    /// object of the same name and a different type (a map named after its
    /// molecule) is passed over. Null when there is none.
    template <class T>
    qlib::LScrSp<T> getObjectByNameAs(const LString &name) const
    {
      for (const ObjectPtr &pObj : getObjectsByName(name)) {
        qlib::LScrSp<T> p(pObj, qlib::no_throw_tag());
        if (!p.isnull())
          return p;
      }
      return qlib::LScrSp<T>();
    }

    int getAllObjectUIDs(qlib::UIDList &uids) const;

    ObjIter beginObj() const { return m_data.begin(); }
    ObjIter endObj() const { return m_data.end(); }

    /// get the number of object in the scene
    int getObjectCount() const { return m_data.size(); }

    // Active object
  private:
    /// Active object's ID
    qlib::uid_t m_nActiveObjID;
    
  public:
    /// Set active object ID in this scene.
    /// This scene also become active as a side effect.
    void setActiveObjID(qlib::uid_t uid);

    qlib::uid_t getActiveObjID() const {
      return m_nActiveObjID;
    }

    //
    // Scripting interface wrapper
    //

    /// get all Object's UID list in comma-separated string
    LString getObjUIDList() const;

    /// Get current data structure in JSON string representation.
    // Without renderer group / used from UI&javascript
    LString getObjectTreeJSON() const;

    /// Get scene information in JSON format (w/ rend groups)
    LString getSceneDataJSON(bool bGroup = true) const;

  private:
    // Object Implementation
    bool registerObjectImpl(ObjectPtr robj);
    
  public:
    ////////////////////////////////////////////////////////////
    // View manager

    /// Create new view
    ViewPtr createView();

    /// Get view object by UID
    ViewPtr getView(qlib::uid_t uid) const;

    /// Get (first) view object by name
    ViewPtr getViewByName(const LString &name) const;

    /// Destroy view by UID
    bool destroyView(qlib::uid_t uid);

    ViewIter beginView() const { return m_viewtab.begin(); }
    ViewIter endView() const { return m_viewtab.end(); }

    /// Get current view count (size)
    int getViewCount() const { return m_viewtab.size(); }

    /// Get view table reference
    const auto &getViewTable() const { return m_viewtab; }

    // Active view
  private:
    /// Active view's ID
    qlib::uid_t m_nActiveViewID;
    
  public:
    /// Set active view
    /// This scene also become active as a side effect.
    void setActiveViewID(qlib::uid_t uid);

    qlib::uid_t getActiveViewID() const {
      return m_nActiveViewID;
    }

    ViewPtr getActiveView() const {
      return getView(m_nActiveViewID);
    }

    //////////
    // Scripting interface wrapper

    LString getViewUIDList() const;
    // qlib::LVarArray getViewArray() const;

    ////////////////////////////////////////////////////////////
    // Camera manager

  private:
    // /// Load camera setting from file (impl/throw excp)
    // CameraPtr loadCameraImpl(const LString &aLocalFile) const;

    /// Register new camera setting (impl/without event firing)
    /// This method overwrite if the camera with the same name exists.
    void setCameraImpl(const LString &name, CameraPtr r);

    /// Next free ui_order slot (max of the registered ones + 1, 0 when empty)
    int nextCameraUIOrder() const;

    /// Cameras in display (ui_order, then name) order
    std::vector<CameraIter> sortedCameras() const;

  public:
    /// Register new camera setting (with event firing)
    /// This method overwrite if the camera with the same name exists.
    void setCamera(const LString &name, CameraPtr r);

    /// Get the copy of the camera by name
    CameraPtr getCamera(const LString &nm) const;

    /// Get the reference of the camera by name
    CameraPtr getCameraRef(const LString &nm) const;

    /// check whether the camera exists or not
    bool hasCamera(const LString &nm) const;

    /// Destroy camera by name
    bool destroyCamera(const LString &nm);

    CameraIter beginCamera() const { return m_camtab.begin(); }
    CameraIter endCamera() const { return m_camtab.end(); }

    int getCameraCount() const { return m_camtab.size(); }

    /// Save view setting to the camera (view --> camera)
    bool saveViewToCam(qlib::uid_t viewid, const LString &nm);

    /// Apply camera setting to the view (camera --> view)
    /// @param viewid target view ID to apply camera setting
    /// @param camname name of the camera
    void loadViewFromCam(qlib::uid_t viewid, const LString &camname) {
      setCamToViewAnim(viewid, camname, false);
    }

    void loadViewFromCamAnim(qlib::uid_t viewid, const LString &camname) {
      setCamToViewAnim(viewid, camname, true);
    }

    /// Apply camera setting to the view with anim (camera --> view)
    /// @param viewid target view ID to apply camera setting
    /// @param camname name of the camera
    /// @param bAnim
    void setCamToViewAnim(qlib::uid_t viewid, const LString &camname, bool bAnim);

    /// retrieve camera information by JSON (for UI)
    LString getCameraInfoJSON() const;

    /// Load camera from the local file
    CameraPtr loadCamera(const LString &filename) const;

    /// Save camera to the local file
    bool saveCameraTo(const LString &name, const LString &filename) const;

    ////////////////////////////////////////////////////////////
    // Renderer manager (cache for display)

    bool addRendCache(RendererPtr rrend);
    bool removeRendCache(RendererPtr rrend);

    void display(DisplayContext *);

    /// CPU point hit test (HittestContext). When bCpuOnly is true, renderers
    /// covered by the GPU pick pass (isPickSupported()) are skipped.
    void processHit(DisplayContext *, bool bCpuOnly = false);

    /// Draw the renderer/element IDs into the bound pick target (pdc in
    /// PICK_DRAW mode). Participants: visible, not UI-locked, isPickSupported()
    /// and default alpha above PICK_ALPHA_THRESHOLD (see-through objects are
    /// skipped so what is behind them can be picked). Each renderer is drawn
    /// inside pdc->startHit(uid)/endHit(), which fills the renderer table read
    /// back by the View.
    void displayPick(DisplayContext *);

    /// True if a visible, unlocked renderer needs the CPU hit test after a GPU
    /// miss (isHitTestSupported() but not isPickSupported()).
    bool hasCpuOnlyHitRenderers() const;

    /// Default alpha at or below which a renderer is click-through: the pick
    /// pass skips it so that what is behind it can be picked instead. A
    /// surface at this alpha is still see-through enough that the user means
    /// to reach the atoms behind it.
    static constexpr double PICK_ALPHA_THRESHOLD = 0.6;

    RendererPtr getRenderer(qlib::uid_t uid) const;
    RendererPtr getRendByName(const LString &nm) const;

  private:
    void displayRendImpl(DisplayContext *pdc, ObjectPtr pObj, RendererPtr pRend);
    
    // Active renderer
  private:
    /// Active renderer's ID
    qlib::uid_t m_nActiveRendID;
    
  public:
    /// Set active renderer ID in this scene.
    /// This scene also become active as a side effect.
    void setActiveRendID(qlib::uid_t uid);

    qlib::uid_t getActiveRendID() const {
      return m_nActiveRendID;
    }

  public:
    ////////////////////////////////////////////////////////////
    // Undo/Redo

    UndoManager *getUndoMgr() {
      return &m_undomgr;
    }

    bool undo(int nstep);

    bool redo(int nstep);

    void startUndoTxn(const LString &descr) {
      m_undomgr.startTxn(descr);
    }
    void rollbackUndoTxn();
    void commitUndoTxn();

    bool isUndoable() const {
      return m_undomgr.isUndoable();
    }
    bool isRedoable() const {
      return m_undomgr.isRedoable();
    }

    LString getUndoDesc(int n) const {
      LString desc;
      m_undomgr.getUndoDesc(n, desc);
      return desc;
    }
    LString getRedoDesc(int n) const {
      LString desc;
      m_undomgr.getRedoDesc(n, desc);
      return desc;
    }

    int getUndoSize() const {
      return m_undomgr.getUndoSize();
    }
    int getRedoSize() const {
      return m_undomgr.getRedoSize();
    }

    // clear undo/redo data for scripting interface
    // this method fires event (sceneundoinfo)
    void clearUndoDataScr();

    /// Merge adjacent undo steps (UndoManager::mergeSteps); fires the
    /// undo-info event when it merged.
    bool mergeUndoSteps(int start, int count);

    ////////////////////////////////////////////////
    // Animation management
  private:
    qlib::LScrSp<AnimMgr> m_pAnimMgr;
  public:
    qlib::LScrSp<AnimMgr> getAnimMgr() const { return m_pAnimMgr; }

    ////////////////////////////////////////////////
    // Application data store
    //  (serialized as <appdata id=... type=...> children of <scene>;
    //   see SceneAppData)
  private:
    struct AppDataEntry {
      /// live object (its class is registered in this build)
      SceneAppDataPtr pObj;
      /// element kept verbatim when the class is not available
      std::unique_ptr<qlib::LDom2Node> pRawNode;
    };
    typedef std::map<LString, AppDataEntry> appdatatab_t;
    appdatatab_t m_appdata;

    /// WriteTo2() impl for the app-data store
    void appDataWriteTo(qlib::LDom2Node *pNode) const;
    /// readFrom2() impl for one <appdata> element
    void appDataReadFrom(qlib::LDom2Node *pNode);

  public:
    /// Get the live app-data object (null when absent or its class is unknown)
    SceneAppDataPtr getAppData(const LString &id) const;

    /// Get the live app-data object, creating an instance of clsname if absent.
    /// Creating the holder is not an edit (no undo info, no event); the first
    /// property write is. Returns null when clsname is not registered.
    SceneAppDataPtr getCreateAppData(const LString &id, const LString &clsname);

    /// True when a live app-data object exists for id
    bool hasAppData(const LString &id) const;

    /// Remove an app-data entry (not undoable, fires no event)
    bool removeAppData(const LString &id);

    /// True while the scene is being deserialized
    bool isLoading() const { return m_bLoading; }

    ////////////////////////////////////////////////
    // Event related operations
  private:
    bool m_bUpdateRequired;

  public:
    void setUpdateFlag() { m_bUpdateRequired = true; }
    void clearUpdateFlag() { m_bUpdateRequired = false; }
    void checkAndUpdate();

    int addListener(SceneEventListener *pL);
    bool removeListener(SceneEventListener *pL);

    int addListener(qlib::LSCBPtr scb);
    bool removeListener(int nid);

    void fireSceneEvent(SceneEvent &ev);

    /// Unloading event handler
    //  (Called by framework before the unloading this scene)
    virtual void unloading();

    //////////
    // for property event propagation
    qlib::uid_t getRootUID() const override;
    /// Property changed event handler for the scene properties
    void propChanged(qlib::LPropEvent &ev) override;

    /// object changed event
    void objectChanged(ObjectEvent &ev) override;

    /// renderer changed event
    void rendererChanged(RendererEvent &ev) override;

    ////////////////////////////////////////////////////////////
    // Serialization/Deserialization

    ///
    /// Serialize this scene to the stream
    ///
    void writeTo2(qlib::LDom2Node *pNode) const override;

    ///
    /// Serialize this scene to the localfile
    ///
    void readFrom2(qlib::LDom2Node *pNode) override;

    /// force to embed all external files (cameras and styles)
    void forceEmbed();

  private:
    // writeTo2/readFrom2 impl for specific settings

    /// WriteTo2() impl for style settings
    void stylesWriteTo(qlib::LDom2Node *pNode) const;
    /// WriteTo2() impl for camera settings
    void camerasWriteTo(qlib::LDom2Node *pNode) const;

    void objectReadFrom(qlib::LDom2Node *pNode);
    void cameraReadFrom(qlib::LDom2Node *pNode);
    void stylesReadFrom(qlib::LDom2Node *pNode);

  private:
    qlib::LDom2Node *m_pQscOpts;

    /// Write a style set loaded from the config dir as a %%CONFDIR%%
    /// reference (true) or embed its contents (false). Set by the qsc writer
    /// for the version it writes for; not persisted.
    bool m_bStyleConfRef = false;

  public:
    void setQscOpts(qlib::LDom2Node *ptree);
    qlib::LDom2Node *getQscOpts() const { return m_pQscOpts; }

    void setStyleConfRef(bool b) { m_bStyleConfRef = b; }
    bool isStyleConfRef() const { return m_bStyleConfRef; }

    ////////////////////////////////////////////////////////////
    // Misc operations

    /// Cleanup all contents of this scene (including views)
    void clearAll();

    /// Cleanup all contents of this scene (other than views)
    void clearAllData();

    /// Scriptable version, cleanup all contents of this scene
    ///  (the same as clearAllData() except firing event)
    void clearAllDataScr();

    /// Show debug dump to the debug stream
    void dump() const;

    ////////////////////////////////////////////////////////////
    // color management
  private:
    /// CMYK proofing flag
    bool m_bUseColProof;

    /// icc profile file name
    LString m_iccFileName;

    // /// color transformation object
    // gfx::CmsXform m_cmsxfm;

  public:
    bool isUseColProof() const { return m_bUseColProof; }
    void setUseColProof(bool b);
    
    const LString &getIccFileName() const { return m_iccFileName; }
    void setIccFileName(const LString &fn);

    int getIccIntent() const;
    void setIccIntent(int n);

    /// convert to string
    LString toString() const override;
    
  };

}

#endif // QSYS_SCENE_HPP_INCLUDE_
