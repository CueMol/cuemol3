// bysidech / bymainch on a nucleotide with PDB v3 (and mmCIF) atom names.
// The selection matches atom names against the sidech / mainch lists of
// data/nucl_props.xml as they are, without resolving aliases: the thymine
// methyl group (C7) and the phosphate oxygens (OP1 OP2) used to be missing
// from those lists. A residue without the lists (water) is in neither set.

#include <gtest/gtest.h>
#include <common.h>

#include "molstr/AtomIterator.hpp"
#include "molstr/MolAtom.hpp"
#include "molstr/MolCoord.hpp"
#include "molstr/PDBFileReader.hpp"
#include "molstr/SelCommand.hpp"
#include "molstr/TopparManager.hpp"

#include <qlib/StringStream.hpp>
#include <qsys/Scene.hpp>
#include <qsys/SceneManager.hpp>

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <set>
#include <string>

using molstr::MolCoordPtr;
using qlib::LString;

namespace {

/// One DT residue, PDB v3 names (coordinates do not matter here)
std::string dtResidue()
{
    const char *names[] = {"P",   "OP1", "OP2", "O5'", "C5'", "C4'", "O4'",
                           "C3'", "O3'", "C2'", "C1'", "N1",  "C2",  "O2",
                           "N3",  "C4",  "O4",  "C5",  "C7",  "C6"};
    std::string pdb;
    int serial = 1;
    for (const char *nm : names) {
        // atom name columns 13-16: a name shorter than 4 starts at column 14
        const std::string field = std::strlen(nm) < 4 ? std::string(" ") + nm : nm;
        char line[96];
        std::snprintf(line, sizeof line,
                      "ATOM  %5d %-4s  DT A   1    %8.3f%8.3f%8.3f  1.00  0.00           %c\n",
                      serial, field.c_str(), serial * 1.0, 0.0, 0.0, nm[0]);
        pdb += line;
        ++serial;
    }
    // a water: its topology (mono_top.xml) defines no main / side chain list
    pdb += "HETATM   99  O   HOH A 101       9.000   9.000   9.000  1.00  0.00           O\n";
    pdb += "END\n";
    return pdb;
}

std::set<std::string> names(const MolCoordPtr &pMol, const char *expr)
{
    molstr::SelCommand *pCom = MB_NEW molstr::SelCommand();
    molstr::SelectionPtr pSel(pCom);
    EXPECT_TRUE(pCom->compile(expr)) << expr;
    std::set<std::string> out;
    molstr::AtomIterator iter(pMol, pSel);
    for (iter.first(); iter.hasMore(); iter.next())
        out.insert(iter.get()->getName().c_str());
    return out;
}

}  // namespace

TEST(NuclSideMainChain, ThymineMethylAndPhosphateOxygens)
{
    // The suite's sysconfig resolves its data files to data/data/... (the
    // config lives in data/ itself), so the nucleic topology is not loaded by
    // the environment: read the files under test explicitly, topology first.
    const std::filesystem::path dataDir =
        std::filesystem::path(CUEMOL2_SYSCONFIG_PATH).parent_path();
    auto *pTM = molstr::TopparManager::getInstance();
    ASSERT_TRUE(pTM->readPrmTop((dataDir / "nucl_top.xml").string().c_str(), "xml"));
    ASSERT_TRUE(pTM->readPrmTop((dataDir / "nucl_props.xml").string().c_str(), "xml"));
    ASSERT_TRUE(pTM->readPrmTop((dataDir / "mono_top.xml").string().c_str(), "xml"));

    qsys::ScenePtr pScene = qsys::SceneManager::getInstance()->createScene();
    const std::string pdb = dtResidue();
    molstr::PDBFileReader reader;
    qlib::StrInStream ins(pdb.c_str(), static_cast<int>(pdb.size()));
    MolCoordPtr pMol(reader.load(ins));
    pScene->addObject(pMol);

    const std::set<std::string> side = names(pMol, "bysidech (*)");
    EXPECT_EQ(side.count("C7"), 1u);
    EXPECT_EQ(side.count("OP1"), 0u);

    const std::set<std::string> main = names(pMol, "bymainch (*)");
    EXPECT_EQ(main.count("OP1"), 1u);
    EXPECT_EQ(main.count("OP2"), 1u);
    EXPECT_EQ(main.count("C7"), 0u);
    EXPECT_EQ(main.count("O"), 0u);  // water

    qsys::SceneManager::getInstance()->destroyScene(pScene->getUID());
}
