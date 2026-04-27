//! Versioned prompt templates for the learning loop.
//!
//! Each submodule pins an explicit `VERSION` constant. Prompt-engineering
//! changes should bump the version so analytics can attribute regressions to
//! a specific template revision.

pub mod mcq_explanation;
pub mod story;
pub mod synonyms;
pub mod writing_grade;
