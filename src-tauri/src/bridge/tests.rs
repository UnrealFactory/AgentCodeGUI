use super::*;

fn manifest(instance: &str) -> Manifest {
    serde_json::from_value(json!({"id":"example.tool", "instanceId":instance, "name":"My tool", "icon":"code", "example/extension":{"v":7}})).unwrap()
}
fn connect(state: &mut Bridge, instance: &str) -> String { state.connect(1, manifest(instance), 100).unwrap()["clientId"].as_str().unwrap().into() }
fn doc(value: u64) -> Document {
    serde_json::from_value(json!({"items":[{"id":"selection", "kind":"my.studio/scene", "title":"선택", "data":{"object":value}, "uri":"scene://local", "range":{"ids":[value]}}],
        "state":{"openDocuments":["scene-1"], "runningJob":value}, "my.studio/version":7})).unwrap()
}
fn capture(chat: &str, client: &str) -> Value {
    json!({"protocolVersion":1,"chatId":chat,"capturedAt":100,"sources":[{"clientId":client,"toolId":"example.tool","name":"Tool","icon":"code","revision":1,"items":[{"id":"a","kind":"custom/type","title":"Chosen object","data":{"v":1}}],"state":{"job":"rendering"}}]})
}

#[test]
fn one_tool_can_connect_to_four_sessions_with_independent_preferences() {
    let mut state = Bridge::new();
    let a=connect(&mut state,"a"); let b=connect(&mut state,"b");
    assert_ne!(state.clients[&a].token,state.clients[&b].token);
    for chat in ["chat-a","chat-b","chat-c","chat-d"] { state.bind(&a,chat.into()).unwrap(); }
    state.bind(&b,"chat-b".into()).unwrap();
    state.configure_binding(&a,"chat-a",|c|{c.enabled=false;c.include_selection=false;}).unwrap();
    assert_eq!(state.clients[&a].saved.bindings.len(),4);
    assert!(!state.clients[&a].saved.bindings["chat-a"].enabled);
    assert!(state.clients[&a].saved.bindings["chat-b"].enabled);
    assert!(state.clients[&b].saved.bindings["chat-b"].enabled);
    state.bind(&a,"chat-a".into()).unwrap();
    assert!(!state.clients[&a].saved.bindings["chat-a"].enabled,"repeated connect must not reset session preferences");
    state.disconnect(&a,"chat-b").unwrap();
    assert_eq!(state.clients[&a].saved.bindings.len(),3);
    assert!(state.clients[&a].saved.bindings.contains_key("chat-c"));
    assert!(state.clients[&b].saved.bindings.contains_key("chat-b"));
    assert!(state.configure_binding(&a,"chat-b",|c|c.enabled=false).is_err());
    assert!(state.configure_binding(&a,"",|c|c.enabled=false).is_err());
}

#[test]
fn document_extensions_and_latest_disabled_value_are_preserved() {
    let mut state=Bridge::new();let a=connect(&mut state,"a");
    state.bind(&a,"chat".into()).unwrap();state.configure_binding(&a,"chat",|c|c.enabled=false).unwrap();
    let version=state.version;
    state.publish(&a,1,doc(1),100).unwrap();state.publish(&a,2,doc(2),101).unwrap();
    assert_eq!(state.version,version,"disabled updates do not fan out full context to every window");
    assert!(state.publish(&a,1,doc(3),102).is_err());
    state.configure_binding(&a,"chat",|c|c.enabled=true).unwrap();
    let s=state.snapshot(None,102);
    assert_eq!(s["clients"][0]["document"]["items"][0]["data"]["object"],2);
    assert_eq!(s["clients"][0]["document"]["items"][0]["range"]["ids"][0],2);
    assert_eq!(s["clients"][0]["document"]["my.studio/version"],7);
    assert_eq!(s["clients"][0]["document"]["state"]["runningJob"],2);
}

#[test]
fn heartbeat_does_not_resend_documents_and_offline_transition_is_visible() {
    let mut state=Bridge::new();let a=connect(&mut state,"a");let v=state.version;
    state.poll(&a,200).unwrap();assert_eq!(state.version,v);
    assert_eq!(state.snapshot(Some(v),201)["unchanged"],true);
    let snap=state.snapshot(Some(v),200+ONLINE_MS+1);
    assert_eq!(snap["clients"][0]["online"],false);
    assert!(state.version>v);let v=state.version;
    state.poll(&a,200+ONLINE_MS+2).unwrap();assert!(state.version>v);
}

#[test]
fn restart_restores_all_bindings_and_preferences_without_live_data() {
    let dir=std::env::temp_dir().join(format!("ccg-bridge-test-{}",id()));
    std::fs::create_dir_all(&dir).unwrap();let path=dir.join("tools.json");
    let mut state=Bridge::new();state.load(path.clone()).unwrap();let a=connect(&mut state,"a");
    state.bind(&a,"chat-a".into()).unwrap();state.configure_binding(&a,"chat-a",|c|{c.enabled=false;c.include_selection=false;}).unwrap();
    state.bind(&a,"chat-b".into()).unwrap();
    state.publish(&a,1,doc(44321),100).unwrap();
    let token=state.clients[&a].token.clone().unwrap();let disk=std::fs::read_to_string(&path).unwrap();
    assert!(!disk.contains(&token));assert!(!disk.contains("44321"));
    let mut next=Bridge::new();next.load(path.clone()).unwrap();
    assert!(next.clients[&a].token.is_none());assert!(!next.clients[&a].online);
    assert!(next.clients[&a].document.items.is_empty());
    let resumed=next.connect(1,manifest("a"),200).unwrap();
    assert_eq!(resumed["clientId"],a);assert_eq!(resumed["bindings"].as_array().unwrap().len(),2);
    assert!(!next.clients[&a].saved.bindings["chat-a"].enabled);
    assert!(!next.clients[&a].saved.bindings["chat-a"].include_selection);
    assert!(next.clients[&a].saved.bindings["chat-b"].enabled);
    assert_eq!(resumed["enabled"],true);assert_eq!(resumed["boundChatId"],"chat-b");
    assert_ne!(resumed["token"].as_str(),Some(token.as_str()));
    assert!(next.connect(1,manifest("a"),201).is_err());
    std::fs::remove_file(path).unwrap();std::fs::remove_dir(dir).unwrap();
}

#[test]
fn failed_preference_write_rolls_back_the_in_memory_binding() {
    let mut state=Bridge::new();let a=connect(&mut state,"a");
    state.bind(&a,"original-chat".into()).unwrap();
    state.settings_path=Some(std::env::temp_dir()); // a directory cannot be replaced by a JSON file
    assert!(state.bind(&a,"new-chat".into()).is_err());
    assert_eq!(state.clients[&a].saved.bindings.len(),1);
    assert!(state.configure_binding(&a,"original-chat",|b|b.enabled=false).is_err());
    assert!(state.clients[&a].saved.bindings["original-chat"].enabled);
    assert!(state.disconnect(&a,"original-chat").is_err());
    assert!(state.clients[&a].saved.bindings.contains_key("original-chat"));
}

#[test]
fn icons_limits_duplicate_items_and_versions_are_validated() {
    assert_eq!(model::icons().as_array().unwrap().len(),20);
    assert_eq!(model::normalized_icon("unregistered"),"tool");
    let mut state=Bridge::new();assert!(state.connect(99,manifest("a"),100).is_err());
    let mut m=manifest("a");m.icon="not-known".into();let a=state.connect(1,m,100).unwrap()["clientId"].as_str().unwrap().to_string();
    assert_eq!(state.clients[&a].saved.manifest.icon,"tool");
    let mut updated=manifest("a");updated.icon="database".into();updated.name="Renamed tool".into();
    state.update_manifest(&a,updated).unwrap();
    assert_eq!(state.clients[&a].saved.manifest.icon,"database");
    assert_eq!(state.clients[&a].saved.manifest.name,"Renamed tool");
    assert!(state.update_manifest(&a,manifest("different-instance")).is_err());
    let mut d=doc(1);d.items.push(d.items[0].clone());assert!(state.publish(&a,1,d,100).is_err());
    let mut d=doc(1);d.items[0].text=Some("x".repeat(model::MAX_DOCUMENT));assert!(d.validate().is_err());
    for i in 1..MAX_CLIENTS { connect(&mut state,&i.to_string()); }
    assert!(state.connect(1,manifest("too-many"),100).is_err());
}

#[test]
fn engine_context_is_frozen_validated_and_only_added_once_per_request() {
    let snap=capture("chat-a","client-a");
    let request=json!({"prompt":"Explain this", "externalContext":snap});
    validate_run("chat-a",&request).unwrap();assert!(validate_run("chat-b",&request).is_err());
    let text=prompt_for_run(&request);assert!(text.contains("rendering"));assert!(text.contains("custom/type"));
    assert_eq!(prompt_for_run(&request),text);assert_eq!(request["prompt"],"Explain this");
    assert_eq!(prompt_for_run(&json!({"prompt":"Hello"})),"Hello");
    let mut wrong=snap;wrong["sources"][0]["items"][0]["text"]=json!("x".repeat(model::MAX_CAPTURE));
    assert!(model::validate_capture("chat-a",&wrong).is_err());
}

#[test]
fn adapter_poll_contains_only_its_own_connection_and_discovery_cleanup_checks_owner() {
    let mut state=Bridge::new();let a=connect(&mut state,"a");let b=connect(&mut state,"b");
    state.bind(&a,"chat-a".into()).unwrap();state.bind(&a,"chat-c".into()).unwrap();state.bind(&b,"chat-b".into()).unwrap();
    assert_eq!(state.poll(&a,100).unwrap()["bindings"].as_array().unwrap().len(),2);
    state.publish(&b,1,doc(97531),100).unwrap();let poll=state.poll(&a,100).unwrap().to_string();
    assert!(!poll.contains("chat-b"));assert!(!poll.contains("97531"));assert!(!poll.contains("agent"));
    assert!(!state.snapshot(None,100).to_string().contains(state.clients[&a].token.as_ref().unwrap()));
    state.leave(&a).unwrap();assert!(state.clients[&a].token.is_none());
    let path=std::env::temp_dir().join(format!("ccg-discovery-{}.json",id()));
    std::fs::write(&path,"{\"pid\":42}").unwrap();remove_discovery(&path,43);assert!(path.exists());remove_discovery(&path,42);assert!(!path.exists());
}

#[test]
fn legacy_single_session_preferences_migrate_without_losing_identity_or_off_state() {
    let dir=std::env::temp_dir().join(format!("ccg-bridge-migrate-{}",id()));
    std::fs::create_dir_all(&dir).unwrap();let path=dir.join("tools.json");
    std::fs::write(&path,json!({"version":1,"clients":[{"id":"legacy-client","manifest":manifest("a"),"boundChatId":"chat-a","enabled":false,"includeSelection":false}]}).to_string()).unwrap();
    let mut state=Bridge::new();state.load(path.clone()).unwrap();
    let saved=&state.clients["legacy-client"].saved;
    assert_eq!(saved.bindings.len(),1);assert!(!saved.bindings["chat-a"].enabled);assert!(!saved.bindings["chat-a"].include_selection);
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["version"],2);
    state.bind("legacy-client","chat-b".into()).unwrap();
    let mut next=Bridge::new();next.load(path.clone()).unwrap();
    assert_eq!(next.clients["legacy-client"].saved.bindings.len(),2);
    assert!(next.clients["legacy-client"].saved.bindings["chat-b"].enabled);
    assert_eq!(next.connect(1,manifest("a"),200).unwrap()["clientId"],"legacy-client");
    std::fs::remove_file(path).unwrap();std::fs::remove_dir(dir).unwrap();
}

#[test]
fn shared_updates_fan_out_while_any_session_is_enabled() {
    let mut state=Bridge::new();let a=connect(&mut state,"a");
    state.bind(&a,"chat-a".into()).unwrap();state.bind(&a,"chat-b".into()).unwrap();
    state.configure_binding(&a,"chat-a",|b|b.enabled=false).unwrap();
    let version=state.version;state.publish(&a,1,doc(1),100).unwrap();
    assert!(state.version>version,"an OFF binding cannot mute another enabled session");
    state.configure_binding(&a,"chat-b",|b|b.enabled=false).unwrap();
    let version=state.version;state.publish(&a,2,doc(2),101).unwrap();assert_eq!(state.version,version);
    state.configure_binding(&a,"chat-a",|b|b.enabled=true).unwrap();
    assert_eq!(state.clients[&a].document.state["runningJob"],2);
    assert!(!state.clients[&a].saved.bindings["chat-b"].enabled);
    state.leave(&a).unwrap();assert_eq!(state.clients[&a].saved.bindings.len(),2);
}
