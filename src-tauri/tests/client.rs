use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    process::Command,
    thread,
};

#[test]
fn cli_validates_before_connecting_and_reports_socket_results() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mdw"))
            .current_dir(dir.path())
            .env("XDG_RUNTIME_DIR", dir.path())
            .args(args)
            .output()
            .unwrap()
    };
    let bad = run(&["missing/note.md"]);
    assert_eq!(bad.status.code(), Some(1));
    assert!(String::from_utf8(bad.stderr)
        .unwrap()
        .contains("Directory does not exist"));
    let runtime = dir.path().join("mdw");
    assert!(!runtime.exists());
    let idle = run(&["--server-status"]);
    assert!(idle.status.success());
    assert!(String::from_utf8(idle.stdout)
        .unwrap()
        .contains("not running"));
    assert_eq!(
        fs::metadata(&runtime).unwrap().permissions().mode() & 0o777,
        0o700
    );

    let listener = UnixListener::bind(runtime.join("server.sock")).unwrap();
    let server = thread::spawn(move || {
        for (expected, response) in [
            (
                serde_json::json!({"v": 1, "op": "status"}),
                r#"{"v":2,"message":"future protocol"}"#,
            ),
            (
                serde_json::json!({"v": 1, "op": "stop", "force": false}),
                r#"{"v":1,"error":"Unsaved changes in note.md"}"#,
            ),
            (
                serde_json::json!({"v": 1, "op": "stop", "force": true}),
                r#"{"v":1}"#,
            ),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&line).unwrap(),
                expected
            );
            writeln!(stream, "{response}").unwrap();
        }
    });
    let incompatible = run(&["--server-status"]);
    assert_eq!(incompatible.status.code(), Some(1));
    assert!(String::from_utf8(incompatible.stderr)
        .unwrap()
        .contains("mdw --stop-server"));
    let dirty = run(&["--stop-server"]);
    assert_eq!(dirty.status.code(), Some(1));
    assert!(String::from_utf8(dirty.stderr)
        .unwrap()
        .contains("Unsaved changes in note.md"));
    assert!(run(&["--stop-server", "--force"]).status.success());
    server.join().unwrap();
}
