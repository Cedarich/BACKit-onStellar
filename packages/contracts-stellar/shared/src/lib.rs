#![no_std]
use soroban_sdk::{contracttype};

// Example shared type
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    Unknown = 1,
}
