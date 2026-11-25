// SceneXMLReader::getLoadErrors: data a scene refers to but cannot load must
// be reported, since read() itself goes on and returns a scene without it
// (cuetty fails the render on such a scene instead of writing an empty image).

#include <gtest/gtest.h>
#include <common.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

#include "qsys/SceneManager.hpp"
#include "qsys/SceneXMLReader.hpp"

namespace {

struct ReadResult
{
    size_t nErrors;
    int nObjects;
};

ReadResult readScene(const std::string &path)
{
    qsys::ScenePtr pScene = qsys::SceneManager::getInstance()->createScene();
    qsys::SceneXMLReader r;
    r.setPath(path.c_str());
    r.attach(pScene);
    r.read();
    r.detach();
    ReadResult res{r.getLoadErrors().size(), pScene->getObjectCount()};
    qsys::SceneManager::getInstance()->destroyScene(pScene->getUID());
    return res;
}

}  // namespace

// A file cut off before its embedded molecule: the XML still asks for
// datachunk:00000, but the reader hits EOF while looking for the next chunk,
// which is its normal way out of the chunk loop -- no exception is thrown.
TEST(SceneLoadErrorsTest, TruncatedEmbeddedDataIsReported)
{
    const std::string src = std::string(CUEMOL2_TEST_DATA_DIR) + "/1crn_movie_test.qsc";
    std::string body;
    {
        std::ifstream in(src, std::ios::binary);
        ASSERT_TRUE(in.good());
        body.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }
    // Only the embedded molecule matters here; the scene's animation needs the
    // anim module, which this suite does not load.
    const size_t a0 = body.find("\t<animation");
    const size_t a1 = body.find("</animation>\n");
    ASSERT_NE(a0, std::string::npos);
    ASSERT_NE(a1, std::string::npos);
    body.erase(a0, a1 + std::string("</animation>\n").size() - a0);

    const size_t cut = body.find("==========START datachunk:00000");
    ASSERT_NE(cut, std::string::npos);

    const std::filesystem::path tmp = std::filesystem::temp_directory_path();
    const std::string intact = (tmp / "scene_load_errors_intact.qsc").string();
    const std::string truncated = (tmp / "scene_load_errors_truncated.qsc").string();
    std::ofstream(intact, std::ios::binary) << body;
    std::ofstream(truncated, std::ios::binary) << body.substr(0, cut);

    // The intact scene loads without errors (no false positive).
    const ReadResult full = readScene(intact);
    EXPECT_EQ(full.nErrors, 0u);
    EXPECT_EQ(full.nObjects, 1);

    const ReadResult part = readScene(truncated);
    EXPECT_EQ(part.nErrors, 1u);

    std::remove(intact.c_str());
    std::remove(truncated.c_str());
}
