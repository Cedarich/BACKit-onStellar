#![no_std]

//! # CallRegistry Contract
//!
//! This contract implements the core logic for prediction calls on Stellar Soroban.
//! It mirrors the functionality of the Solidity CallRegistry.sol but is adapted for Soroban.
//!
//! ## Deviations from Solidity Implementation
//!
//! 1. **Storage**: Uses Soroban's `persistent` storage with `DataKey` enum instead of Solidity mappings.
//! 2. **Token Transfers**: Uses `soroban_sdk::token::Client` for interacting with Stellar Asset Contracts (SAC) instead of `IERC20`.
//! 3. **Authorization**: Uses `Address::require_auth()` instead of `msg.sender` checks.
//! 4. **Data Types**:
//!    - `address` -> `Address`
//!    - `bytes32` -> `BytesN<32>`
//!    - `string` -> `String`
//! 5. **Events**: Uses `env.events().publish()` with topics.
//! 6. **Call ID**: Sequentially generated using a counter stored in `DataKey::NextCallId`.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, String, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Call {
    pub creator: Address,
    pub stake_token: Address,
    pub total_stake_yes: i128,
    pub total_stake_no: i128,
    pub start_ts: u64,
    pub end_ts: u64,
    pub token_address: Address,
    pub pair_id: BytesN<32>,
    pub ipfs_cid: String,
    pub settled: bool,
    pub outcome: bool,
    pub final_price: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Call(u64),
    NextCallId,
    UserStake(u64, Address, bool), // call_id, user, position (true=YES, false=NO)
}

#[contract]
pub struct CallRegistry;

#[contractimpl]
impl CallRegistry {
    /// Creates a new prediction call.
    ///
    /// # Arguments
    /// * `env` - The environment.
    /// * `creator` - The address creating the call.
    /// * `stake_token` - The token used for staking.
    /// * `amount` - The amount of stake tokens to transfer from creator.
    /// * `end_ts` - The timestamp when the call ends.
    /// * `token_address` - The address of the token being predicted.
    /// * `pair_id` - The ID of the pair.
    /// * `ipfs_cid` - IPFS CID for additional call metadata.
    ///
    /// # Returns
    /// The new call ID.
    pub fn create_call(
        env: Env,
        creator: Address,
        stake_token: Address,
        amount: i128,
        end_ts: u64,
        token_address: Address,
        pair_id: BytesN<32>,
        ipfs_cid: String,
    ) -> u64 {
        creator.require_auth();

        // Transfer stake from creator to contract
        let token_client = token::Client::new(&env, &stake_token);
        token_client.transfer(&creator, &env.current_contract_address(), &amount);

        let call_id = Self::get_next_call_id(&env);
        let start_ts = env.ledger().timestamp();

        let call = Call {
            creator: creator.clone(),
            stake_token,
            total_stake_yes: 0,
            total_stake_no: 0,
            start_ts,
            end_ts,
            token_address,
            pair_id,
            ipfs_cid,
            settled: false,
            outcome: false,
            final_price: 0,
        };

        env.storage().persistent().set(&DataKey::Call(call_id), &call);
        
        env.events().publish((Symbol::new(&env, "CallCreated"), call_id, creator), call_id);

        call_id
    }

    /// Stakes on a prediction call.
    ///
    /// # Arguments
    /// * `env` - The environment.
    /// * `call_id` - The ID of the call to stake on.
    /// * `staker` - The address staking.
    /// * `amount` - The amount to stake.
    /// * `position` - The position to take (true for YES, false for NO).
    pub fn stake_on_call(
        env: Env,
        call_id: u64,
        staker: Address,
        amount: i128,
        position: bool,
    ) {
        staker.require_auth();

        let mut call: Call = env.storage().persistent().get(&DataKey::Call(call_id)).unwrap_or_else(|| panic!("Call not found"));

        if call.settled {
            panic!("Call is settled");
        }
        
        if env.ledger().timestamp() >= call.end_ts {
            panic!("Call has ended");
        }

        // Transfer stake
        let token_client = token::Client::new(&env, &call.stake_token);
        token_client.transfer(&staker, &env.current_contract_address(), &amount);

        // Update stakes
        if position {
            call.total_stake_yes += amount;
        } else {
            call.total_stake_no += amount;
        }

        // Save call
        env.storage().persistent().set(&DataKey::Call(call_id), &call);

        // Record user stake
        let key = DataKey::UserStake(call_id, staker.clone(), position);
        let current_stake: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current_stake + amount));

        env.events().publish((Symbol::new(&env, "StakeAdded"), call_id, staker), (amount, position));
    }

    /// Retrieves call details.
    ///
    /// # Arguments
    /// * `env` - The environment.
    /// * `call_id` - The ID of the call.
    ///
    /// # Returns
    /// The call details if found, otherwise None.
    pub fn get_call(env: Env, call_id: u64) -> Option<Call> {
        env.storage().persistent().get(&DataKey::Call(call_id))
    }

    /// Retrieves a user's stake on a specific position for a call.
    ///
    /// # Arguments
    /// * `env` - The environment.
    /// * `call_id` - The ID of the call.
    /// * `user` - The user's address.
    /// * `position` - The position (true for YES, false for NO).
    ///
    /// # Returns
    /// The amount staked.
    pub fn get_user_stake(env: Env, call_id: u64, user: Address, position: bool) -> i128 {
        env.storage().persistent().get(&DataKey::UserStake(call_id, user, position)).unwrap_or(0)
    }

    fn get_next_call_id(env: &Env) -> u64 {
        let key = DataKey::NextCallId;
        let id: u64 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(id + 1));
        id
    }
}

#[cfg(test)]
mod test;
