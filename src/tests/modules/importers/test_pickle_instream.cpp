#include <gtest/gtest.h>
#include <common.h>
#include <cstring>
#include <memory>
#include <string>
#include <qlib/LExceptions.hpp>
#include <qlib/StringStream.hpp>
#include "importers/PickleInStream.hpp"

using importers::PickleInStream;
using qlib::LString;
using qlib::LVarDict;
using qlib::LVariant;
using qlib::LVarList;
using qlib::StrInStream;

namespace {

// Emits the subset of pickle protocol 2 opcodes that PickleInStream reads.
class PickleBuilder
{
public:
    void emptyDict()
    {
        m_buf += '}';
    }
    void emptyList()
    {
        m_buf += ']';
    }
    void mark()
    {
        m_buf += '(';
    }
    void stop()
    {
        m_buf += '.';
    }
    void setItem()
    {
        m_buf += 's';
    }
    void setItems()
    {
        m_buf += 'u';
    }
    void appends()
    {
        m_buf += 'e';
    }
    void binput(int i)
    {
        m_buf += 'q';
        m_buf += char(i);
    }
    void binget(int i)
    {
        m_buf += 'h';
        m_buf += char(i);
    }
    void binint(int v)
    {
        m_buf += 'J';
        le32(v);
    }
    void binstring(const std::string &s)
    {
        m_buf += 'T';
        le32(int(s.size()));
        m_buf += s;
    }
    void binunicode(const std::string &s)
    {
        m_buf += 'X';
        le32(int(s.size()));
        m_buf += s;
    }

    void binfloat(double d)
    {
        m_buf += 'G';
        unsigned char raw[sizeof(double)];
        std::memcpy(raw, &d, sizeof(double));
        // BINFLOAT payload is big-endian
        if (hostIsLittleEndian()) {
            for (int i = int(sizeof(double)) - 1; i >= 0; --i) m_buf += char(raw[i]);
        } else {
            for (int i = 0; i < int(sizeof(double)); ++i) m_buf += char(raw[i]);
        }
    }

    void longBinput(int i)
    {
        m_buf += 'r';
        le32(i);
    }
    void longBinget(int i)
    {
        m_buf += 'j';
        le32(i);
    }
    /// Python 3's protocol 0-1 form of an int outside the int32 range
    void longText(const std::string &digits)
    {
        m_buf += 'L';
        m_buf += digits + "L\n";
    }
    void global(const std::string &module, const std::string &name)
    {
        m_buf += 'c';
        m_buf += module + '\n' + name + '\n';
    }
    void emptyTuple()
    {
        m_buf += ')';
    }
    void tuple()
    {
        m_buf += 't';
    }
    void reduce()
    {
        m_buf += 'R';
    }
    void build()
    {
        m_buf += 'b';
    }

    /// Python 3's protocol 0-2 form of a bytes value:
    /// _codecs.encode(<str>, "latin1"), the str given as UTF-8
    void bytesValue(const std::string &utf8)
    {
        global("_codecs", "encode");
        mark();
        binunicode(utf8);
        binunicode("latin1");
        tuple();
        reduce();
    }

    /// Length header that claims more bytes than follow (simulates a truncated file)
    void truncatedUnicode(int claimed, const std::string &partial)
    {
        m_buf += 'X';
        le32(claimed);
        m_buf += partial;
    }

    const std::string &bytes() const
    {
        return m_buf;
    }

private:
    static bool hostIsLittleEndian()
    {
        const unsigned short one = 1;
        return *reinterpret_cast<const unsigned char *>(&one) == 1;
    }

    void le32(int v)
    {
        const unsigned int u = static_cast<unsigned int>(v);
        for (int i = 0; i < 4; ++i) m_buf += char((u >> (8 * i)) & 0xffu);
    }

    std::string m_buf;
};

// Parses the pickle and destroys the stream before returning, so the result
// must not alias anything the stream owned (its stack or memo).
std::unique_ptr<LVariant> parse(const PickleBuilder &pb)
{
    StrInStream ins(pb.bytes().data(), static_cast<int>(pb.bytes().size()));
    PickleInStream pis(ins);
    return std::unique_ptr<LVariant>(pis.getMap());
}

}  // namespace

TEST(PickleInStream, SetItemsBuildsDictWithNestedListAndMemoRefs)
{
    PickleBuilder pb;
    pb.emptyDict();
    pb.binput(0);
    pb.mark();
    pb.binunicode("version");
    pb.binput(1);
    pb.binint(1810);
    pb.binunicode("names");
    pb.binput(2);
    pb.emptyList();
    pb.mark();
    pb.binget(1);  // "version" again, through the memo
    pb.binfloat(1.5);
    pb.binstring("abc");
    pb.appends();
    pb.binunicode("flag");
    pb.binget(2);  // "names" reused as a value
    pb.setItems();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    ASSERT_TRUE(pTop->isDict());
    LVarDict *pDict = pTop->getDictPtr();

    EXPECT_EQ(pDict->getInt("version"), 1810);
    EXPECT_STREQ(pDict->getString("flag").c_str(), "names");

    LVarList *pNames = pDict->getList("names");
    ASSERT_NE(pNames, nullptr);
    ASSERT_EQ(pNames->size(), 3u);
    EXPECT_STREQ(pNames->getString(0).c_str(), "version");
    EXPECT_DOUBLE_EQ(pNames->getReal(1), 1.5);
    EXPECT_STREQ(pNames->getString(2).c_str(), "abc");

    // getList() hands out the stored list, not a copy
    EXPECT_EQ(pDict->getList("names"), pNames);
}

TEST(PickleInStream, SetItemStoresSingleEntry)
{
    PickleBuilder pb;
    pb.emptyDict();
    pb.binunicode("k");
    pb.binint(5);
    pb.setItem();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    ASSERT_TRUE(pTop->isDict());
    EXPECT_EQ(pTop->getDictPtr()->getInt("k"), 5);
}

TEST(PickleInStream, UnicodeStringIsBoundedByItsLength)
{
    // The bytes after "ab" are opcodes; they must not leak into the string.
    PickleBuilder pb;
    pb.emptyDict();
    pb.binunicode("k");
    pb.binunicode("ab");
    pb.setItem();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    EXPECT_STREQ(pTop->getDictPtr()->getString("k").c_str(), "ab");
}

TEST(PickleInStream, PyMOL2SessionTailWithReduceParses)
{
    // The tail of a session saved by PyMOL 2.x (Python 3): a
    // pymol.Session_Storage object (GLOBAL + EMPTY_TUPLE + REDUCE + BUILD)
    // and the "wizard" entry as bytes. Unknown opcode 41 used to abort here.
    PickleBuilder pb;
    pb.emptyDict();
    pb.mark();
    pb.binunicode("version");
    pb.binint(2004000);
    pb.binunicode("session");
    pb.global("pymol", "Session_Storage");
    pb.emptyTuple();
    pb.reduce();
    pb.emptyDict();
    pb.build();
    pb.binunicode("wizard");
    pb.bytesValue(std::string("]q\0.", 4));
    pb.setItems();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    ASSERT_TRUE(pTop->isDict());
    LVarDict *pDict = pTop->getDictPtr();
    EXPECT_EQ(pDict->getInt("version"), 2004000);

    // a call other than _codecs.encode stays unevaluated: ["reduce", func, args]
    LVarList *pSession = pDict->getList("session");
    ASSERT_NE(pSession, nullptr);
    ASSERT_EQ(pSession->size(), 3u);
    EXPECT_STREQ(pSession->getString(0).c_str(), "reduce");

    // the bytes keep their embedded NUL
    const LString wizard = pDict->getString("wizard");
    ASSERT_EQ(wizard.length(), 4);
    EXPECT_EQ(std::string(wizard.c_str(), 4), std::string("]q\0.", 4));
}

TEST(PickleInStream, DeepLongBinputStringIsRetrievable)
{
    // PyMOL 2.x sessions memoize per-atom strings (residue numbers, ...)
    // with LONG_BINPUT deep inside the object lists and reuse them through
    // LONG_BINGET; a reader that drops them yields "LONG_BINGET" instead.
    PickleBuilder pb;
    pb.emptyDict();
    pb.mark();
    pb.binunicode("k");
    for (int depth = 2; depth <= 6; ++depth) {
        pb.emptyList();
        pb.mark();  // mark depth reaches 6 on the last iteration
    }
    pb.binunicode("12A");
    pb.longBinput(300);
    pb.longBinget(300);
    for (int depth = 6; depth >= 2; --depth)
        pb.appends();
    pb.setItems();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    LVarList *pList = pTop->getDictPtr()->getList("k");
    for (int level = 0; level < 4; ++level) {
        ASSERT_EQ(pList->size(), 1u);
        pList = pList->at(0)->getListPtr();
    }
    ASSERT_EQ(pList->size(), 2u);
    EXPECT_STREQ(pList->getString(0).c_str(), "12A");
    EXPECT_STREQ(pList->getString(1).c_str(), "12A");
}

TEST(PickleInStream, LongKeepsThe32BitPatternOfAtomFlags)
{
    // PyMOL 2.x atom flags such as 0x88000040 exceed int32, so Python 3
    // writes them with LONG; "Unknown opcode 76" used to abort here.
    PickleBuilder pb;
    pb.emptyDict();
    pb.binunicode("flags");
    pb.longText("2281701440");  // 0x88000040
    pb.setItem();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    const int flags = pTop->getDictPtr()->getInt("flags");
    EXPECT_EQ(static_cast<unsigned int>(flags), 0x88000040u);
}

TEST(PickleInStream, BytesValueMapsLatin1CodePointsToBytes)
{
    // U+00E9 and U+00FF arrive as UTF-8 and must come back as 0xE9 0xFF
    PickleBuilder pb;
    pb.emptyDict();
    pb.binunicode("k");
    pb.bytesValue("a\xc3\xa9\xc3\xbf");
    pb.setItem();
    pb.stop();

    std::unique_ptr<LVariant> pTop = parse(pb);
    const LString v = pTop->getDictPtr()->getString("k");
    ASSERT_EQ(v.length(), 3);
    EXPECT_EQ(std::string(v.c_str(), 3), std::string("a\xe9\xff"));
}

TEST(PickleInStream, SetItemsWithOddItemCountThrows)
{
    PickleBuilder pb;
    pb.emptyDict();
    pb.mark();
    pb.binunicode("k");  // key without a value
    pb.setItems();
    pb.stop();
    EXPECT_THROW(parse(pb), qlib::LException);
}

TEST(PickleInStream, TruncatedStringThrows)
{
    PickleBuilder pb;
    pb.emptyDict();
    pb.truncatedUnicode(100, "abc");
    EXPECT_THROW(parse(pb), qlib::LException);
}
