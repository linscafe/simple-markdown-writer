use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
};

pub type Marks = Vec<(String, f64)>;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Open {
        path: Option<PathBuf>,
        #[serde(default)]
        timing: bool,
        #[serde(default)]
        quit: bool,
    },
    Status,
    Stop {
        #[serde(default)]
        force: bool,
    },
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Response {
    pub error: Option<String>,
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Marks,
}

#[derive(Serialize)]
struct Packet<T> {
    v: u32,
    #[serde(flatten)]
    body: T,
}

pub fn send(stream: &mut UnixStream, body: impl Serialize) -> Result<(), String> {
    let mut line = serde_json::to_vec(&Packet { v: 1, body }).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| e.to_string())
}

pub fn receive<T: DeserializeOwned>(stream: &UnixStream) -> Result<T, String> {
    let mut line = String::new();
    let bytes = BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if bytes == 0 {
        return Err("mdw connection closed before replying".into());
    }
    let packet: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let version = &packet["v"];
    if version.as_u64() != Some(1) {
        return Err(format!(
            "Unsupported mdw protocol version {version}. Run mdw --stop-server and retry."
        ));
    }
    serde_json::from_value(packet).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_line_round_trip_and_incompatible_version() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        send(
            &mut a,
            Request::Open {
                path: Some("a\nb.md".into()),
                timing: true,
                quit: false,
            },
        )
        .unwrap();
        assert!(
            matches!(receive(&b), Ok(Request::Open {path: Some(p), timing: true, ..}) if p == std::path::Path::new("a\nb.md"))
        );
        send(&mut b, Response::default()).unwrap();
        assert!(receive::<Response>(&a).unwrap().error.is_none());
        a.write_all(b"{\"v\":2,\"op\":\"future\"}\n").unwrap();
        assert!(receive::<Request>(&b)
            .unwrap_err()
            .contains("mdw --stop-server"));
    }
}
