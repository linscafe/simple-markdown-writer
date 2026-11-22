use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

struct Process {
    parent: u32,
    webkit: bool,
    rss_pages: u64,
}

fn parse_stat(stat: &str, executable: Option<&str>) -> Option<Process> {
    // comm may contain spaces and right parentheses. Linux also truncates it
    // to 15 bytes, so prefer the executable name where procfs exposes it.
    let (prefix, fields) = stat.rsplit_once(") ")?;
    let (_, comm) = prefix.split_once('(')?;
    let mut fields = fields.split_whitespace();
    let parent = fields.nth(1)?.parse().ok()?;
    let rss_pages = fields.nth(19)?.parse().ok()?;
    let webkit = matches!(
        executable,
        Some("WebKitWebProcess" | "WebKitNetworkProcess")
    ) || matches!(
        comm,
        "WebKitWebProces" | "WebKitNetworkPr" | "WebKitWebProcess" | "WebKitNetworkProcess"
    );
    Some(Process {
        parent,
        webkit,
        rss_pages,
    })
}

fn belongs_to(pid: u32, root: u32, processes: &HashMap<u32, Process>) -> bool {
    let mut next = pid;
    let mut visited = HashSet::new();
    while let Some(p) = processes.get(&next) {
        if next == root {
            return true;
        }
        if !visited.insert(next) {
            break;
        }
        next = p.parent;
    }
    false
}

fn kib(text: &str, field: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        line.strip_prefix(field)?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

fn totals(procfs: &Path, root: u32, page_kib: u64) -> Option<(u64, Option<u64>)> {
    let mut processes = HashMap::new();
    for entry in fs::read_dir(procfs).ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let dir = entry.path();
        let Ok(stat) = fs::read_to_string(dir.join("stat")) else {
            continue;
        };
        let exe = fs::read_link(dir.join("exe")).ok();
        if let Some(process) = parse_stat(
            &stat,
            exe.as_deref()
                .and_then(Path::file_name)
                .and_then(|s| s.to_str()),
        ) {
            processes.insert(pid, process);
        }
    }
    processes.get(&root)?;
    let mut rss = 0;
    let mut pss = Some(0);
    for (&pid, p) in &processes {
        if pid != root && !(p.webkit && belongs_to(pid, root, &processes)) {
            continue;
        }
        let text = fs::read_to_string(procfs.join(pid.to_string()).join("smaps_rollup"))
            .unwrap_or_default();
        rss += kib(&text, "Rss:").unwrap_or(p.rss_pages * page_kib);
        pss = pss.zip(kib(&text, "Pss:")).map(|(sum, k)| sum + k);
    }
    Some((rss, pss))
}

pub fn summary(pid: u32) -> String {
    // SAFETY: sysconf takes a constant and does not access caller memory.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    match totals(Path::new("/proc"), pid, page.max(1024) as u64 / 1024) {
        Some((rss, pss)) => format!(
            "RSS {rss} KiB, PSS {}",
            pss.map_or_else(|| "unavailable".into(), |n| format!("{n} KiB"))
        ),
        None => "RSS and PSS unavailable".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sums_server_and_webkit_descendants_through_helpers() {
        let temp = tempfile::tempdir().unwrap();
        for (pid, name, parent) in [
            (1, "mdw", 0),
            (2, "helper ) x", 1),
            (3, "WebKitWebProces", 2),
            (4, "WebKitNetworkPr", 1),
            (5, "WebKitWebProces", 99),
        ] {
            let dir = temp.path().join(pid.to_string());
            fs::create_dir(&dir).unwrap();
            fs::write(
                dir.join("stat"),
                format!("{pid} ({name}) S {parent} {} 6 0", "0 ".repeat(19)),
            )
            .unwrap();
            fs::write(
                dir.join("smaps_rollup"),
                "Rss: 30 kB\nPss: 10 kB\nPss_Anon: 4 kB\n",
            )
            .unwrap();
        }
        assert_eq!(totals(temp.path(), 1, 4), Some((90, Some(30))));
        fs::remove_file(temp.path().join("3/smaps_rollup")).unwrap();
        assert_eq!(totals(temp.path(), 1, 4), Some((84, None)));
    }
}
