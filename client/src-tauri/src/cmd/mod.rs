//! Pier's commands, called by the interface (tauri::command), by subject. Each module
//! sees the whole crate (use crate::*), and the crate sees their items.

pub(crate) mod send;
pub(crate) mod terminals;
pub(crate) mod shares;
pub(crate) mod setup;
pub(crate) mod forge;
pub(crate) mod labs;
pub(crate) mod take_back;
