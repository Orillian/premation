// The engine API in its JSON (TypeScript object) form — P7a, docs/PLUGIN_SDK.md
// "Commands". A native plugin command speaks the API as JSON through
// PrCommandSuite (pr_command.h): `{"type":"setProperty","prop":{…},"value":{"kind":"scalar","value":3}}`.
//
// Reflective, not hand-written: the codegen emits the schema as data
// (native/protocol/generated/api_schema.inc, generate.cjs genCppSchema), and
// this file walks it to translate JSON ⇄ the canonical wire bytes, which the
// generated binary codec then decodes / produced. So every command, query and
// result the schema has is available, with the same shapes the TypeScript
// client uses:
//   struct            an object of its fields (camelCase, as in the schema)
//   flat union        `{ "type": "<variant>", …the variant's fields }` (Command, Query, results)
//   other union       `{ "kind": "<variant>", "value": … }` (`value` absent for a void variant)
//   enum              its member name
//   i32 / u32 / i64 / u64 / f32 / f64   a number (times are integer flicks)
//   bytes             base64
// A required field the JSON leaves out takes its zero value (0, "", false, the
// enum's 0 member, an empty struct); a required union is an error.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "json.hpp"

namespace premation::plugins {

/// JSON text → a command / query (`error` says why not: bad JSON, unknown type, a field of the wrong kind).
[[nodiscard]] std::optional<api::Command> command_from_json(std::string_view json, std::string& error);
[[nodiscard]] std::optional<api::Query> query_from_json(std::string_view json, std::string& error);

/// Results and errors → JSON text (a result is its flat-union object, `type` = the command / query name).
[[nodiscard]] std::string to_json(const api::CommandResult& r);
[[nodiscard]] std::string to_json(const api::QueryResult& r);
/// `{"code":"notFound","message":"…"}` (+ the optional fields that are set).
[[nodiscard]] std::string to_json(const api::EngineError& e);

/// The generic halves (tests, tools): a JSON value of schema type `type` (a struct or union name)
/// ⇄ its wire body. nullopt with `error` on failure.
[[nodiscard]] std::optional<std::vector<std::uint8_t>> json_to_wire(const js::Json& v, std::string_view type, std::string& error);
[[nodiscard]] std::optional<js::Json> wire_to_json(std::span<const std::uint8_t> bytes, std::string_view type, std::string& error);

}  // namespace premation::plugins
