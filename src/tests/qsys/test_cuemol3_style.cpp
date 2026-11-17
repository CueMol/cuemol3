// The CueMol3 style files: cuemol3_style.xml (global additions) and
// cuemol3_look.xml (the CueMol3 look, a style set of each new scene), and how
// a scene carries the look in a qsc (a %%CONFDIR%% reference, or embedded
// when written for an older version).

#include <gtest/gtest.h>
#include <common.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "qlib/LDOM2Tree.hpp"
#include "qsys/Scene.hpp"
#include "qsys/SceneManager.hpp"
#include "qsys/SceneXMLReader.hpp"
#include "qsys/SceneXMLWriter.hpp"
#include "qsys/SysConfig.hpp"
#include "qsys/style/StyleFile.hpp"
#include "qsys/style/StyleMgr.hpp"

using qlib::LString;
using qsys::SceneManager;
using qsys::ScenePtr;
using qsys::StyleMgr;

namespace {

// Value of one style property, as the renderer style sheet resolves it.
std::string styleValue(qlib::uid_t ctxt, const char *style, const char *prop)
{
    qlib::LDom2Node *pNode = StyleMgr::getInstance()->getStyleNode2(style, prop, ctxt);
    return pNode == NULL ? std::string() : std::string(pNode->getValue().c_str());
}

// Position of the style set named `name` in the list of the context
// (the JSON listing follows the list order, i.e. the priority order).
size_t posOf(qlib::uid_t ctxt, const char *name)
{
    const std::string js(StyleMgr::getInstance()->getStyleSetsJSON(ctxt).c_str());
    return js.find(std::string("\"name\":\"") + name + "\"");
}

}  // namespace

// CueMol3 loads cuemol3_style.xml over default_style.xml globally: it only
// adds names, so default_style.xml's values stay. The overrides are in
// cuemol3_look.xml: a property it defines wins, one it leaves out falls back.
TEST(Cuemol3StyleFile, LookOverridesPerPropertyOverDefaultStyle)
{
    // a private context id, so the global style sets are left alone
    const qlib::uid_t ctxt = 987655;
    const LString dir(CUEMOL2_DATA_DIR);

    qsys::StyleFile sfile;
    sfile.loadFile(dir + "/default_style.xml", ctxt);
    EXPECT_EQ(StyleMgr::getInstance()->getStyleNode("DefaultPymRendPreset", ctxt), nullptr);

    sfile.loadFile(dir + "/cuemol3_style.xml", ctxt);
    EXPECT_EQ(styleValue(ctxt, "DefaultRibbon", "helix.width"), "0.2");
    EXPECT_NE(StyleMgr::getInstance()->getStyleNode("DefaultPymRendPreset", ctxt), nullptr);

    sfile.loadFile(dir + "/cuemol3_look.xml", ctxt);
    EXPECT_EQ(styleValue(ctxt, "DefaultRibbon", "helix.width"), "0.18");
    EXPECT_EQ(styleValue(ctxt, "DefaultRibbon", "helix.type"), "rectangle");
    EXPECT_EQ(styleValue(ctxt, "DefaultNucl", "section.tuber"), "2.5");
}

class Cuemol3LookQscTest : public ::testing::Test {
protected:
    LString m_savedConfDir;

    void SetUp() override
    {
        // The source tree stands in for the install dir: data/ is under it.
        qsys::SysConfig *pConf = qsys::SysConfig::getInstance();
        m_savedConfDir = pConf->get("config_dir");
        const std::filesystem::path top =
            std::filesystem::path(CUEMOL2_DATA_DIR).parent_path();
        pConf->put("config_dir", top.string().c_str());
    }

    void TearDown() override
    {
        qsys::SysConfig::getInstance()->put("config_dir", m_savedConfDir);
    }

    static void destroy(ScenePtr &p)
    {
        qlib::uid_t uid = p->getUID();
        p = ScenePtr();
        SceneManager::getInstance()->destroyScene(uid);
    }

    static std::string save(ScenePtr pScene, const std::string &path, const char *compat)
    {
        qsys::SceneXMLWriter w;
        w.setPath(path.c_str());
        w.setCompat(compat);
        w.attach(pScene);
        w.write();
        w.detach();
        std::ifstream ifs(path, std::ios::binary);
        std::stringstream ss;
        ss << ifs.rdbuf();
        return ss.str();
    }

    static ScenePtr load(const std::string &path)
    {
        ScenePtr pScene = SceneManager::getInstance()->createScene();
        qsys::SceneXMLReader r;
        r.setPath(path.c_str());
        r.attach(pScene);
        r.read();
        r.detach();
        EXPECT_TRUE(r.getErrMsg().isEmpty()) << r.getErrMsg().c_str();
        return pScene;
    }
};

// Written for 3.0, the look is a %%CONFDIR%% reference (no machine-specific
// alt_src); written for an older version (the default), it is embedded. Both
// read back to the same style values, and a set created afterwards (e.g. the
// scene's "default") takes priority over the look either way.
TEST_F(Cuemol3LookQscTest, ReferOrEmbedByCompatAndReadBack)
{
    ScenePtr pScene = SceneManager::getInstance()->createScene();
    StyleMgr *pSM = StyleMgr::getInstance();
    pSM->loadStyleSetFromFileAt(pScene->getUID(), "%%CONFDIR%%/data/cuemol3_look.xml", true, true);
    ASSERT_EQ(styleValue(pScene->getUID(), "DefaultRibbon", "helix.width"), "0.18");

    const std::string path =
        (std::filesystem::temp_directory_path() / "cuemol_test_look.qsc").string();

    const std::string ref = save(pScene, path, "3.0");
    EXPECT_NE(ref.find("src=\"%%CONFDIR%%/data/cuemol3_look.xml\""), std::string::npos);
    EXPECT_EQ(ref.find("alt_src"), std::string::npos);
    ScenePtr pRef = load(path);
    EXPECT_EQ(styleValue(pRef->getUID(), "DefaultRibbon", "helix.width"), "0.18");
    destroy(pRef);

    const std::string emb = save(pScene, path, "");
    EXPECT_EQ(emb.find("%%CONFDIR%%"), std::string::npos);
    ScenePtr pEmb = load(path);
    EXPECT_EQ(styleValue(pEmb->getUID(), "DefaultRibbon", "helix.width"), "0.18");

    // The embedded look is neither read-only nor a reference; a set made
    // afterwards still goes above it.
    ASSERT_FALSE(pSM->createStyleSet("default", pEmb->getUID()).isnull());
    EXPECT_LT(posOf(pEmb->getUID(), "default"), posOf(pEmb->getUID(), "cuemol3_look"));

    destroy(pEmb);
    destroy(pScene);
    std::remove(path.c_str());
}
