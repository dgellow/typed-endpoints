/**
 * The fixed part of a generated Rust module.
 *
 * `serde` checks the shape of a value and stops at the first thing that
 * is wrong. A contract says more (lengths, bounds, patterns, closed
 * objects), and its TypeScript side reports every issue with its path. So
 * the generated module does not rely on `serde` to validate: it carries
 * the contract's JSON Schemas and this small interpreter for them. A
 * request is checked as plain JSON first, with every issue collected, and
 * only then turned into the typed value a handler receives. What a
 * handler returns goes the other way: to JSON, checked, then sent.
 *
 * The interpreter covers the JSON Schema that Zod emits, not all of JSON
 * Schema, and it words and codes its issues the way Zod does.
 *
 * @module
 */

/** Imports and the validation runtime. */
export const RUNTIME = String.raw`
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, LazyLock};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};

// =============================================================================
// Validation
// =============================================================================

/// One thing a value got wrong.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// Where: keys and indexes from the root of the part that was checked.
    pub path: Vec<Value>,
    /// What is wrong there.
    pub message: String,
    /// The kind of issue, named as Zod names it.
    pub code: &'static str,
}

/// The part of a request a schema describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Body,
    Query,
    Params,
}

impl Part {
    fn name(self) -> &'static str {
        match self {
            Part::Body => "body",
            Part::Query => "query",
            Part::Params => "params",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Part::Body => "Validation error",
            Part::Query => "Query validation error",
            Part::Params => "Params validation error",
        }
    }
}

/// What Zod calls the type of a JSON value.
fn kind_of(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The length of a string as the contract counts it: in code points.
/// Zod and JSON Schema both do; it is neither the number of bytes nor
/// what JavaScript's length gives for characters outside the BMP.
fn length_of(text: &str) -> u64 {
    text.chars().count() as u64
}

/// A number as JavaScript writes it: an integer has no fraction.
fn js_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

/// A JavaScript pattern as one this engine reads the same way.
///
/// In JavaScript, without the u flag, the classes for digits and word
/// characters and the word boundary are ASCII; here they are Unicode
/// unless told otherwise. Everything else is passed on as it is.
fn from_javascript(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut in_class = false;
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match (chars.next(), in_class) {
                (Some('d'), false) => out.push_str("[0-9]"),
                (Some('D'), false) => out.push_str("[^0-9]"),
                (Some('w'), false) => out.push_str("[A-Za-z0-9_]"),
                (Some('W'), false) => out.push_str("[^A-Za-z0-9_]"),
                (Some('b'), false) => out.push_str("(?-u:\\b)"),
                (Some('B'), false) => out.push_str("(?-u:\\B)"),
                (Some('d'), true) => out.push_str("0-9"),
                (Some('w'), true) => out.push_str("A-Za-z0-9_"),
                // A class inside a class is a union here.
                (Some('D'), true) => out.push_str("[^0-9]"),
                (Some('W'), true) => out.push_str("[^A-Za-z0-9_]"),
                // In a class, a backspace.
                (Some('b'), true) => out.push_str("\\x08"),
                (Some(other), _) => {
                    out.push('\\');
                    out.push(other);
                }
                (None, _) => out.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

static PATTERNS: LazyLock<std::sync::Mutex<HashMap<String, Option<fancy_regex::Regex>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Whether a JavaScript pattern from a schema matches. A pattern this
/// engine cannot compile is reported as a mismatch of every value, and
/// logged once.
fn pattern_matches(pattern: &str, text: &str) -> bool {
    let mut patterns = PATTERNS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let compiled = patterns.entry(pattern.to_string()).or_insert_with(|| {
        fancy_regex::Regex::new(&from_javascript(pattern))
            .map_err(|error| eprintln!("typed-endpoints: pattern {pattern:?} does not compile: {error}"))
            .ok()
    });
    match compiled {
        Some(regex) => regex.is_match(text).unwrap_or(false),
        None => false,
    }
}

/// Checks JSON values against the JSON Schema of one part of a contract.
struct Checker<'a> {
    /// The schema document: references resolve against it.
    root: &'a Value,
    issues: Vec<Issue>,
    /// Whether the values arrived as text (a query, a path).
    text: bool,
}

impl<'a> Checker<'a> {
    fn new(root: &'a Value) -> Self {
        Checker { root, issues: Vec::new(), text: false }
    }

    fn issue(&mut self, path: &[Value], code: &'static str, message: String) {
        self.issues.push(Issue { path: path.to_vec(), message, code });
    }

    fn resolve(&self, schema: &'a Value) -> &'a Value {
        let mut current = schema;
        // A reference is to the document itself or to one of its definitions.
        while let Some(reference) = current.get("$ref").and_then(Value::as_str) {
            current = if reference == "#" {
                self.root
            } else {
                let name = reference.trim_start_matches("#/$defs/");
                match self.root.get("$defs").and_then(|defs| defs.get(name)) {
                    Some(target) => target,
                    None => return &Value::Null,
                }
            };
        }
        current
    }

    /// The member that tells alternatives apart: each is an object that
    /// requires it, with a constant of its own.
    fn discriminator(&self, alternatives: &'a [Value]) -> Option<(&'a str, Vec<&'a Value>)> {
        if alternatives.len() < 2 {
            return None;
        }
        let first = self.resolve(&alternatives[0]).get("properties")?.as_object()?;
        'names: for name in first.keys() {
            let mut constants: Vec<&'a Value> = Vec::new();
            for alternative in alternatives {
                let rules = self.resolve(alternative);
                let required = rules
                    .get("required")
                    .and_then(Value::as_array)
                    .is_some_and(|names| names.iter().any(|required| required.as_str() == Some(name.as_str())));
                let constant = rules
                    .get("properties")
                    .and_then(|properties| properties.get(name))
                    .and_then(|property| property.get("const"))
                    .filter(|constant| constant.is_string());
                match constant {
                    Some(constant) if required && !constants.contains(&constant) => constants.push(constant),
                    _ => continue 'names,
                }
            }
            return Some((name.as_str(), constants));
        }
        None
    }

    /// Whether the value fits the schema, without recording why not.
    fn fits(&self, schema: &'a Value, value: &Value) -> bool {
        let mut probe = Checker::new(self.root);
        probe.text = self.text;
        let mut copy = value.clone();
        probe.check(schema, Some(&mut copy), &mut Vec::new());
        probe.issues.is_empty()
    }

    /// Check a value; record what is wrong. An integer written with a
    /// fraction of zero (1.0) is rewritten as an integer, which is what it
    /// is in JavaScript.
    fn check(&mut self, schema: &'a Value, value: Option<&mut Value>, path: &mut Vec<Value>) {
        let schema = self.resolve(schema);
        let Some(rules) = schema.as_object() else {
            // {} and true accept anything; a missing value is still missing.
            if value.is_none() {
                self.issue(path, "invalid_type", "Invalid input: expected a value, received undefined".into());
            }
            return;
        };

        // A value that is listed: a missing one is not.
        if let Some(constant) = rules.get("const") {
            if value.as_deref() != Some(constant) {
                self.issue(path, "invalid_value", format!("Invalid input: expected {constant}"));
            }
            return;
        }
        if let Some(options) = rules.get("enum").and_then(Value::as_array) {
            if !value.as_deref().is_some_and(|value| options.contains(value)) {
                let listed: Vec<String> = options.iter().map(Value::to_string).collect();
                self.issue(path, "invalid_value", format!("Invalid option: expected one of {}", listed.join("|")));
            }
            return;
        }

        if let Some(alternatives) = rules.get("anyOf").or_else(|| rules.get("oneOf")).and_then(Value::as_array) {
            // T or null: what is wrong with a value that is not null is
            // what is wrong with it as a T.
            let is_null = |alternative: &&'a Value| self.resolve(alternative).get("type").and_then(Value::as_str) == Some("null");
            let others: Vec<&'a Value> = alternatives.iter().filter(|alternative| !is_null(alternative)).collect();
            if others.len() == 1 && alternatives.len() > 1 {
                match value {
                    Some(Value::Null) => {}
                    other => self.check(others[0], other, path),
                }
                return;
            }
            // A member that tells the alternatives apart decides which
            // one the value is checked as.
            let discriminator = self.discriminator(alternatives);
            let Some(value) = value else {
                if discriminator.is_some() {
                    self.issue(path, "invalid_type", "Invalid input: expected object, received undefined".into());
                } else {
                    self.issue(path, "invalid_union", "Invalid input".into());
                }
                return;
            };
            if let Some((tag, constants)) = discriminator {
                if !value.is_object() {
                    let actual = kind_of(Some(value));
                    self.issue(path, "invalid_type", format!("Invalid input: expected object, received {actual}"));
                    return;
                }
                let chosen = value.get(tag).and_then(|given| constants.iter().position(|constant| *constant == given));
                match chosen {
                    Some(index) => self.check(&alternatives[index], Some(value), path),
                    None => {
                        let listed: Vec<String> =
                            constants.iter().map(|constant| format!("'{}'", constant.as_str().unwrap_or_default())).collect();
                        path.push(json!(tag));
                        self.issue(path, "invalid_union", format!("Invalid discriminator value. Expected {}", listed.join(" | ")));
                        path.pop();
                    }
                }
                return;
            }
            for alternative in alternatives {
                if self.fits(alternative, value) {
                    // Checked again for its effect on the value.
                    self.check(alternative, Some(value), path);
                    return;
                }
            }
            self.issue(path, "invalid_union", "Invalid input".into());
            return;
        }
        // The type: one name, a list of names, or none (anything). Null
        // beside one other type is that type, nullable; beside several
        // it is a union.
        let allowed: Vec<&str> = match rules.get("type") {
            Some(Value::String(name)) => vec![name.as_str()],
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        let several = allowed.iter().filter(|name| **name != "null").count() > 1;

        let Some(value) = value else {
            if several {
                self.issue(path, "invalid_union", "Invalid input".into());
            } else {
                let expected = expected_type(rules);
                self.issue(path, "invalid_type", format!("Invalid input: expected {expected}, received undefined"));
            }
            return;
        };
        if let Some(parts) = rules.get("allOf").and_then(Value::as_array) {
            for part in parts {
                self.check(part, Some(&mut *value), path);
            }
            return;
        }

        if !allowed.is_empty() {
            let actual = kind_of(Some(value));
            let integral = value.as_f64().is_some_and(|number| number.fract() == 0.0);
            let fits = allowed.iter().any(|name| match *name {
                "integer" => actual == "number" && integral,
                other => other == actual,
            });
            if !fits && several {
                self.issue(path, "invalid_union", "Invalid input".into());
                return;
            }
            if !fits {
                // A number where an integer is asked for has the right
                // kind and the wrong value.
                let numeric = allowed.contains(&"integer") || allowed.contains(&"number");
                let message = if allowed.contains(&"integer") && actual == "number" {
                    "Invalid input: expected int, received number".to_string()
                } else if self.text && numeric && actual == "string" {
                    // Text that is not a number, read as a number.
                    format!("Invalid input: expected {}, received NaN", expected_type(rules))
                } else {
                    format!("Invalid input: expected {}, received {actual}", expected_type(rules))
                };
                self.issue(path, "invalid_type", message);
                return;
            }
        }

        match value {
            Value::String(text) => self.check_string(rules, text, path),
            Value::Number(number) => {
                let amount = number.as_f64().unwrap_or(f64::NAN);
                self.check_number(rules, amount, path);
                if allowed.contains(&"integer") && !number.is_i64() && !number.is_u64() && amount.fract() == 0.0 {
                    *number = Number::from(amount as i64);
                }
            }
            Value::Array(items) => self.check_array(rules, items, path),
            Value::Object(members) => self.check_object(rules, members, path),
            Value::Null | Value::Bool(_) => {}
        }
    }

    fn check_string(&mut self, rules: &'a Map<String, Value>, text: &str, path: &[Value]) {
        let length = length_of(text);
        let limit = |key: &str| rules.get(key).and_then(Value::as_u64);
        if let Some(minimum) = limit("minLength").filter(|minimum| length < *minimum) {
            self.issue(path, "too_small", format!("Too small: expected string to have >={minimum} characters"));
        }
        if let Some(maximum) = limit("maxLength").filter(|maximum| length > *maximum) {
            self.issue(path, "too_big", format!("Too big: expected string to have <={maximum} characters"));
        }
        let pattern = rules.get("pattern").and_then(Value::as_str);
        if let Some(pattern) = pattern.filter(|pattern| !pattern_matches(pattern, text)) {
            // A format is written as a pattern; its name says what is wrong.
            let message = match rules.get("format").and_then(Value::as_str) {
                Some(format) => format!("Invalid {}", format_noun(format)),
                None => format!("Invalid string: must match pattern /{pattern}/"),
            };
            self.issue(path, "invalid_format", message);
        }
    }

    fn check_number(&mut self, rules: &'a Map<String, Value>, amount: f64, path: &[Value]) {
        let bound = |key: &str| rules.get(key).and_then(Value::as_f64);
        // The range of integers a JavaScript number holds exactly is the
        // bound of an int, not one the schema's author wrote.
        const SAFE: f64 = 9007199254740991.0;
        if let Some(minimum) = bound("minimum").filter(|minimum| amount < *minimum) {
            let what = if minimum == -SAFE { "int" } else { "number" };
            self.issue(path, "too_small", format!("Too small: expected {what} to be >={}", js_number(minimum)));
        }
        if let Some(minimum) = bound("exclusiveMinimum").filter(|minimum| amount <= *minimum) {
            self.issue(path, "too_small", format!("Too small: expected number to be >{}", js_number(minimum)));
        }
        if let Some(maximum) = bound("maximum").filter(|maximum| amount > *maximum) {
            let what = if maximum == SAFE { "int" } else { "number" };
            self.issue(path, "too_big", format!("Too big: expected {what} to be <={}", js_number(maximum)));
        }
        if let Some(maximum) = bound("exclusiveMaximum").filter(|maximum| amount >= *maximum) {
            self.issue(path, "too_big", format!("Too big: expected number to be <{}", js_number(maximum)));
        }
        let off_step = |step: &f64| *step != 0.0 && ((amount / step) - (amount / step).round()).abs() > 1e-9;
        if let Some(step) = bound("multipleOf").filter(off_step) {
            self.issue(path, "not_multiple_of", format!("Invalid number: must be a multiple of {}", js_number(step)));
        }
    }

    fn check_array(&mut self, rules: &'a Map<String, Value>, items: &mut [Value], path: &mut Vec<Value>) {
        let count = items.len() as u64;
        let limit = |key: &str| rules.get(key).and_then(Value::as_u64);
        if let Some(minimum) = limit("minItems").filter(|minimum| count < *minimum) {
            self.issue(path, "too_small", format!("Too small: expected array to have >={minimum} items"));
        }
        if let Some(maximum) = limit("maxItems").filter(|maximum| count > *maximum) {
            self.issue(path, "too_big", format!("Too big: expected array to have <={maximum} items"));
        }
        // A tuple gives a schema per position; a list one for every item.
        let positions = rules.get("prefixItems").and_then(Value::as_array);
        let every = rules.get("items").filter(|schema| schema.is_object());
        for (index, item) in items.iter_mut().enumerate() {
            let schema = positions.and_then(|schemas| schemas.get(index)).or(every);
            if let Some(schema) = schema {
                path.push(json!(index));
                self.check(schema, Some(item), path);
                path.pop();
            }
        }
    }

    fn check_object(&mut self, rules: &'a Map<String, Value>, members: &mut Map<String, Value>, path: &mut Vec<Value>) {
        let properties = rules.get("properties").and_then(Value::as_object);
        let named = |name: &str| properties.is_some_and(|known| known.contains_key(name));
        let required: Vec<&str> = rules
            .get("required")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        for (name, schema) in properties.into_iter().flatten() {
            path.push(json!(name));
            match members.get_mut(name) {
                Some(member) => self.check(schema, Some(member), path),
                None if required.contains(&name.as_str()) => self.check(schema, None, path),
                None => {}
            }
            path.pop();
        }

        // Members the schema does not name: refused by a closed object,
        // checked by a mapping, ignored otherwise.
        match rules.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                let unknown: Vec<String> = members
                    .keys()
                    .filter(|name| !named(name))
                    .map(|name| format!("\"{name}\""))
                    .collect();
                if !unknown.is_empty() {
                    let noun = if unknown.len() == 1 { "key" } else { "keys" };
                    self.issue(path, "unrecognized_keys", format!("Unrecognized {noun}: {}", unknown.join(", ")));
                }
            }
            Some(schema) if schema.is_object() => {
                for (name, member) in members.iter_mut() {
                    if !named(name) {
                        path.push(json!(name));
                        self.check(schema, Some(member), path);
                        path.pop();
                    }
                }
            }
            _ => {}
        }
    }
}

/// A string format, as Zod names it in a message.
fn format_noun(format: &str) -> &str {
    match format {
        "date-time" => "ISO datetime",
        "date" => "ISO date",
        "time" => "ISO time",
        "duration" => "ISO duration",
        "email" => "email address",
        "uuid" => "UUID",
        "uri" => "URL",
        "ipv4" => "IPv4 address",
        "ipv6" => "IPv6 address",
        other => other,
    }
}

/// The type a schema asks for, as Zod words it in a message.
fn expected_type(rules: &Map<String, Value>) -> String {
    let name = match rules.get("type") {
        Some(Value::String(name)) => Some(name.as_str()),
        // With null: the other type.
        Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).find(|name| *name != "null"),
        _ => None,
    };
    match name {
        Some("integer") => "number".into(),
        Some("array") if rules.contains_key("prefixItems") => "tuple".into(),
        Some("object") if !rules.contains_key("properties") => "record".into(),
        Some(name) => name.into(),
        // No type: anything, which a missing value is not.
        None => "nonoptional".into(),
    }
}

// =============================================================================
// Requests
// =============================================================================

/// The number a text is, as JavaScript's Number() reads it: blank text is
/// 0, and 0x, 0o and 0b start a hexadecimal, octal or binary integer.
fn number_from_text(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    let radix = match text.get(..2) {
        Some("0x") | Some("0X") => Some(16),
        Some("0o") | Some("0O") => Some(8),
        Some("0b") | Some("0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        return u64::from_str_radix(&text[2..], radix).ok().map(|number| number as f64);
    }
    // Rust also reads "inf" and "nan" as numbers; JavaScript does not.
    if text.chars().any(|c| c.is_alphabetic() && c != 'e' && c != 'E') {
        return None;
    }
    text.parse::<f64>().ok().filter(|number| number.is_finite())
}

/// Query and path values arrive as text. Where the schema asks for a
/// number, a boolean or a list, the text is turned into one before it is
/// checked; text that is not one is left as it is and fails the check.
fn from_text(root: &Value, schema: &Value, value: Value) -> Value {
    let checker = Checker::new(root);
    let schema = checker.resolve(schema);
    let types: Vec<&str> = match schema.get("type") {
        Some(Value::String(name)) => vec![name.as_str()],
        Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    match value {
        Value::String(text) => {
            let wants = |name: &str| types.contains(&name);
            let number = if wants("integer") || wants("number") { number_from_text(&text) } else { None };
            if let Some(number) = number {
                return if number.fract() == 0.0 && number.abs() < 9.1e15 {
                    json!(number as i64)
                } else {
                    json!(number)
                };
            }
            if wants("boolean") {
                match text.as_str() {
                    "true" => return Value::Bool(true),
                    "false" => return Value::Bool(false),
                    _ => {}
                }
            }
            if wants("array") {
                // One occurrence of a key that takes a list.
                return from_text(root, schema, Value::Array(vec![Value::String(text)]));
            }
            Value::String(text)
        }
        Value::Array(items) => match schema.get("items") {
            Some(item) if item.is_object() => {
                Value::Array(items.into_iter().map(|value| from_text(root, item, value)).collect())
            }
            _ => Value::Array(items),
        },
        Value::Object(members) => {
            let properties = schema.get("properties").and_then(Value::as_object);
            Value::Object(
                members
                    .into_iter()
                    .map(|(name, member)| match properties.and_then(|known| known.get(&name)) {
                        Some(property) => {
                            let member = from_text(root, property, member);
                            (name, member)
                        }
                        None => (name, member),
                    })
                    .collect(),
            )
        }
        other => other,
    }
}

/// The answer to a request that fails validation: which part, and each
/// issue, in the shape the TypeScript handlers use.
fn invalid(part: Part, issues: Vec<Issue>) -> Response {
    let listed: Vec<String> = issues
        .iter()
        .map(|issue| {
            if issue.path.is_empty() {
                issue.message.clone()
            } else {
                let keys: Vec<String> = issue
                    .path
                    .iter()
                    .map(|key| key.as_str().map(str::to_string).unwrap_or_else(|| key.to_string()))
                    .collect();
                format!("{}: {}", keys.join("."), issue.message)
            }
        })
        .collect();
    let body = json!({
        "error": format!("{}: {}", part.prefix(), listed.join(", ")),
        "in": part.name(),
        "issues": issues,
    });
    (StatusCode::BAD_REQUEST, axum::Json(body)).into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({ "error": "Internal Server Error" }))).into_response()
}

/// A checked value as the type a handler receives.
fn typed<T: DeserializeOwned>(part: Part, schema: &Value, value: Option<Value>) -> Result<T, Box<Response>> {
    let mut checker = Checker::new(schema);
    checker.text = matches!(part, Part::Query | Part::Params);
    let mut value = value;
    checker.check(schema, value.as_mut(), &mut Vec::new());
    if !checker.issues.is_empty() {
        return Err(Box::new(invalid(part, checker.issues)));
    }
    serde_json::from_value(value.unwrap_or(Value::Null)).map_err(|error| {
        // The schema accepted the value and the type did not: the two
        // were generated from the same contract and disagree.
        eprintln!("typed-endpoints: a {} that its schema accepts does not fit its type: {error}", part.name());
        Box::new(internal_error())
    })
}

/// Whether a body with this Content-Type is taken to be meant as JSON. No
/// value and text/plain count: a client that sets no header sends a text
/// body as text/plain.
fn meant_as_json(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else { return true };
    let media = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    media.is_empty() || media == "application/json" || media.ends_with("+json") || media == "text/plain"
}

/// The JSON body of a request as the type a handler receives.
fn body_of<T: DeserializeOwned>(schema: &Value, headers: &HeaderMap, bytes: &Bytes) -> Result<T, Box<Response>> {
    let text = String::from_utf8_lossy(bytes);
    let value = if text.trim().is_empty() {
        // No body: checked as a missing value.
        None
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => Some(value),
            Err(_) => {
                let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
                return Err(Box::new(if meant_as_json(content_type) {
                    let body = json!({ "error": "Invalid JSON body", "in": "json", "issues": [] });
                    (StatusCode::BAD_REQUEST, axum::Json(body)).into_response()
                } else {
                    let body = json!({
                        "error": format!(
                            "Unsupported content type \"{}\": the body has to be JSON",
                            content_type.unwrap_or("")
                        ),
                        "in": "content-type",
                        "issues": [],
                    });
                    (StatusCode::UNSUPPORTED_MEDIA_TYPE, axum::Json(body)).into_response()
                }));
            }
        }
    };
    typed(Part::Body, schema, value)
}

/// The query string as the type a handler receives. A key that occurs
/// several times is a list.
fn query_of<T: DeserializeOwned>(schema: &Value, pairs: Vec<(String, String)>) -> Result<T, Box<Response>> {
    let mut members: Map<String, Value> = Map::new();
    for (name, text) in pairs {
        match members.get_mut(&name) {
            Some(Value::Array(items)) => items.push(Value::String(text)),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, Value::String(text)]);
            }
            None => {
                members.insert(name, Value::String(text));
            }
        }
    }
    typed(Part::Query, schema, Some(from_text(schema, schema, Value::Object(members))))
}

/// The path parameters as the type a handler receives.
fn params_of<T: DeserializeOwned>(schema: &Value, values: HashMap<String, String>) -> Result<T, Box<Response>> {
    let members: Map<String, Value> = values.into_iter().map(|(name, text)| (name, Value::String(text))).collect();
    typed(Part::Params, schema, Some(from_text(schema, schema, Value::Object(members))))
}

// =============================================================================
// Responses
// =============================================================================

/// What a handler returned as a response: serialised, checked against the
/// schema of that status, then sent. A value the schema rejects is a 500
/// and is logged, never sent.
fn respond<T: Serialize>(operation: &str, status: u16, schema: Option<&Value>, value: &T) -> Response {
    let mut json = match serde_json::to_value(value) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("typed-endpoints: {operation}: the returned value cannot be written as JSON: {error}");
            return internal_error();
        }
    };
    if let Some(schema) = schema {
        let mut checker = Checker::new(schema);
        checker.check(schema, Some(&mut json), &mut Vec::new());
        if !checker.issues.is_empty() {
            eprintln!(
                "typed-endpoints: {operation}: the value returned for status {status} does not match its schema: {}",
                serde_json::to_string(&checker.issues).unwrap_or_default()
            );
            return internal_error();
        }
    }
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, axum::Json(json)).into_response()
}

/// Reads a field that may be absent, null, or a value, keeping the three
/// apart: absent is None, null is Some(None).
fn nullable_member<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Reads a field that may be absent and whose type has a value for null
/// of its own: a null that is there is that value, not an absent field.
fn present_member<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn schema(text: &str) -> Value {
    serde_json::from_str(text).expect("a generated schema is JSON")
}

fn default_value<T: DeserializeOwned>(text: &str) -> T {
    serde_json::from_str(text).expect("a generated default fits its type")
}
`.trimStart();
