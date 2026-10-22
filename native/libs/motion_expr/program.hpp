// motion_expr internals — the parsed expression (exprLang.ts `ExprNode`),
// extended with the statement forms AE-style rigs use (docs/EXPRESSION_LANGUAGE.md).
//
// A flat node array with index links instead of a pointer tree: a 200 000-term
// `1+1+…` (which the TypeScript parses and then refuses to evaluate) builds and
// frees without recursion, and a Program is one allocation-stable block that
// Values may point into (string literals).
//
// A single expression parses to exactly the nodes it always did and `root` is
// that expression: the evaluator's fast path never sees a statement. Only a
// source with two or more statements, a declaration or a block gets a kBlock
// root and a local-variable frame.

#ifndef MOTION_EXPR_PROGRAM_HPP
#define MOTION_EXPR_PROGRAM_HPP

#include <cstdint>
#include <exception>
#include <utility>
#include <string>
#include <string_view>
#include <vector>

#include "value.hpp"

namespace motion::expr::detail {

enum class NodeKind : std::uint8_t {
  // expressions (exprLang.ts)
  kNum, kStr, kBool, kNull, kIdent, kArray, kMember, kCall, kUnary, kBinary, kLogical, kConditional,
  // expressions (statements extension)
  kLocal,     // a resolved local variable: `depth` function frames up, `slot`
  kAssign,    // a = b / a op= b (op = kNone for plain `=`)
  kUpdate,    // ++a / a++ (op = kAdd or kSub, `prefix`)
  kFunction,  // function expression / declaration (`decl`) / arrow (`arrow`, `expr_body`)
  kObject,    // { k: v, … }: list = key (kStr, `key` resolved) / value node pairs
  kTemplate,  // `a${b}c`: list = the pieces (kStr) and substitutions, in order
  kOptChain,  // a member / call chain holding `?.`: a = the chain (a nullish `?.` ends it with undefined)
  // statements
  kBlock,     // { list… } (own `scope`)
  kVarList,   // var/let/const a = …, b = … (list of kVarDecl)
  kVarDecl,   // one declarator: `slot` = a
  kIf,        // if (a) b else c
  kWhile,     // while (a) b
  kFor,       // for (a; b; c) d (own `scope`)
  kReturn,    // return a
  kBreak, kContinue,
  kEmpty,     // `;`
  kDoWhile,   // do b while (a)
  kForOf,     // for (a of b) d / for (a in b) d (`boolean`: of) (own `scope`); a = kVarDecl or a target
  kSwitch,    // switch (a) { list… of kCase } (own `scope`)
  kCase,      // case a: list… (a = kNoNode: default)
  kTry,       // try a catch (slot) b finally c (b / c may be kNoNode; `decl`: the catch binds a name)
  kThrow,     // throw a
};

enum class Op : std::uint8_t {
  kNone,
  // binary (exprLang.ts BinaryOp)
  kMul, kDiv, kMod, kAdd, kSub, kLt, kLe, kGt, kGe, kEq, kNe, kStrictEq, kStrictNe,
  kPow,
  // logical
  kAnd, kOr,
  // unary
  kNeg, kPlus, kNot, kTypeof,
  // 2026-10-21: `??`, the bitwise operators and `~`
  kNullish, kBitAnd, kBitOr, kBitXor, kShl, kShr, kUShr, kBitNot
};

/// "No source position".
inline constexpr std::uint32_t kNoPos = 0xffffffffU;

struct Node {
  NodeKind kind = NodeKind::kNull;
  Op op = Op::kNone;
  bool computed = false;    // member: a[b] vs a.b
  bool boolean = false;     // kBool; kLocal: the binding is `const`
  bool decl = false;        // kFunction: a declaration statement (hoisted in its block)
  bool arrow = false;       // kFunction: an arrow function
  bool expr_body = false;   // kFunction: arrow with an expression body (a is the expression)
  bool prefix = false;      // kUpdate: ++a rather than a++
  bool optional = false;    // kMember / kCall: reached through `?.`
  bool has_defaults = false;  // kFunction: list holds one default-value node (or kNoNode) per parameter
  std::uint16_t depth = 0;  // kLocal: function frames between the use and the declaration
  std::uint32_t pos = kNoPos;  // source offset (UTF-16 units into the trimmed source) for error positions
  Global global = Global::kNone;  // kIdent: resolved scope slot (kNone → "X is not defined")
  KeyId key = KeyId::kUnknown;    // kMember (non-computed): the property's KeyId
  double num = 0;           // kNum
  std::uint32_t a = kNoNode;  // member object / call callee / unary arg / binary left / cond test / body…
  std::uint32_t b = kNoNode;  // member property / binary right / cond consequent / if-then / while-body
  std::uint32_t c = kNoNode;  // cond alternate / if-else / for-update
  std::uint32_t d = kNoNode;  // for-body
  std::uint32_t list = 0;     // array items / call args / block statements / declarators: first index into Program::lists
  std::uint32_t count = 0;    // … and how many (kFunction: the parameter count)
  std::uint32_t str = 0;      // kStr / kIdent / non-computed member / function name: index into Program::strings
  std::uint32_t slot = 0;     // kLocal / kVarDecl: the frame slot
  std::uint32_t scope = kNoNode;  // kBlock / kFunction / kFor: parse-time scope id (resolver only)
  std::uint32_t nslots = 0;   // kFunction: the frame size of a call
};

struct Program {
  std::vector<Node> nodes;
  std::vector<std::uint32_t> lists;
  std::vector<Str> strings;  // never grows after parse: Values point into it
  std::uint32_t root = kNoNode;
  std::uint32_t top_slots = 0;  // the program's own local-variable frame (0: none needed)
};

/// Thrown by the lexer/parser (exprLang.ts ExprSyntaxError).
struct SyntaxError : std::exception {
  explicit SyntaxError(Str m, std::uint32_t p = kNoPos) : message(std::move(m)), pos(p) {}
  [[nodiscard]] const char* what() const noexcept override { return "motion::expr::SyntaxError"; }
  Str message;
  std::uint32_t pos;  // offset of the offending token / character in the parsed source (kNoPos: unknown)
};

/// Parse `src` (already trimmed) into a Program. Throws SyntaxError.
[[nodiscard]] Program parse(std::u16string_view src);

}  // namespace motion::expr::detail

#endif  // MOTION_EXPR_PROGRAM_HPP
