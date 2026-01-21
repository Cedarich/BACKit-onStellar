use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env, String};

#[test]
fn test_create_call() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, CallRegistry);
    let client = CallRegistryClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let stake_token = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token_client = token::Client::new(&env, &stake_token.address());
    let token_admin = token::StellarAssetClient::new(&env, &stake_token.address());
    
    token_admin.mint(&creator, &1000);

    let end_ts = env.ledger().timestamp() + 1000;
    let token_address = Address::generate(&env);
    let pair_id = BytesN::from_array(&env, &[0u8; 32]);
    let ipfs_cid = String::from_str(&env, "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");

    let call_id = client.create_call(
        &creator,
        &stake_token.address(),
        &100,
        &end_ts,
        &token_address,
        &pair_id,
        &ipfs_cid,
    );

    assert_eq!(call_id, 0);
    assert_eq!(token_client.balance(&creator), 900);
    assert_eq!(token_client.balance(&contract_id), 100);

    let call = client.get_call(&0).unwrap();
    assert_eq!(call.creator, creator);
    assert_eq!(call.end_ts, end_ts);
    assert_eq!(call.ipfs_cid, ipfs_cid);
}

#[test]
fn test_stake_on_call() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, CallRegistry);
    let client = CallRegistryClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let staker = Address::generate(&env);
    let stake_token = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token_admin = token::StellarAssetClient::new(&env, &stake_token.address());
    
    token_admin.mint(&creator, &1000);
    token_admin.mint(&staker, &1000);

    let end_ts = env.ledger().timestamp() + 1000;
    let token_address = Address::generate(&env);
    let pair_id = BytesN::from_array(&env, &[0u8; 32]);
    let ipfs_cid = String::from_str(&env, "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");

    client.create_call(
        &creator,
        &stake_token.address(),
        &100,
        &end_ts,
        &token_address,
        &pair_id,
        &ipfs_cid,
    );

    client.stake_on_call(&0, &staker, &200, &true);

    let call = client.get_call(&0).unwrap();
    assert_eq!(call.total_stake_yes, 200);
    assert_eq!(call.total_stake_no, 0);
    assert_eq!(client.get_user_stake(&0, &staker, &true), 200);
}

#[test]
#[should_panic(expected = "Call has ended")]
fn test_stake_after_end() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, CallRegistry);
    let client = CallRegistryClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let staker = Address::generate(&env);
    let stake_token = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token_admin = token::StellarAssetClient::new(&env, &stake_token.address());
    
    token_admin.mint(&creator, &1000);
    token_admin.mint(&staker, &1000);

    let end_ts = env.ledger().timestamp() + 1000;
    let token_address = Address::generate(&env);
    let pair_id = BytesN::from_array(&env, &[0u8; 32]);
    let ipfs_cid = String::from_str(&env, "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");

    client.create_call(
        &creator,
        &stake_token.address(),
        &100,
        &end_ts,
        &token_address,
        &pair_id,
        &ipfs_cid,
    );

    env.ledger().set_timestamp(end_ts + 1);

    client.stake_on_call(&0, &staker, &200, &true);
}
