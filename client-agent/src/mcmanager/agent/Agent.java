package mcmanager.agent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.lang.instrument.Instrumentation;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs before Minecraft starts (-javaagent) and brings this setup's mods,
 * shader packs and resource packs in line with the server. Any failure is
 * logged and the game starts with the files it already has.
 *
 * Also runnable directly for testing: java -jar agent.jar <setupId> [gameDir]
 */
public final class Agent {
    static final String VERSION = "4";
    static final List<String> SHARED_KINDS = List.of("shaderpacks", "resourcepacks");
    static final Pattern SAFE_NAME = Pattern.compile("^[^\\\\/:*?\"<>|\\x00-\\x1f]+$");

    private Path root;
    private Path game;
    private String api;
    private String slug;
    private PrintWriter log;
    private final Map<String, String> hashCache = new HashMap<>();

    record Setup(String id, String vid, String label, String mc, boolean active, String hash) {}
    record Entry(String setup, String kind, String name, String hash, long size, List<String> urls) {}

    public static void premain(String args, Instrumentation inst) {
        new Agent().run(args);
    }

    public static void main(String[] args) {
        if (args.length > 1) System.setProperty("mcmanager.gameDir", args[1]);
        new Agent().run(args.length > 0 ? args[0] : null);
    }

    void run(String setupId) {
        long started = System.nanoTime();
        try {
            String rootProp = System.getProperty("mcmanager.root");
            root = rootProp != null ? Paths.get(rootProp)
                : Paths.get(Agent.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
            game = Paths.get(System.getProperty("mcmanager.gameDir", System.getProperty("user.dir"))).toAbsolutePath();
            openLog();
            log("agent " + VERSION + " starting for " + setupId + " in " + game);
            sync(setupId);
        } catch (Throwable error) {
            log("sync failed, starting with the current files: " + error);
        } finally {
            log("done in " + (System.nanoTime() - started) / 1_000_000 + " ms");
            if (log != null) log.close();
        }
    }

    // ---------------------------------------------------------------- sync

    void sync(String setupId) throws Exception {
        Properties props = new Properties();
        try (InputStream in = Files.newInputStream(root.resolve("client.properties"))) {
            props.load(in);
        }
        api = props.getProperty("base").replaceAll("/+$", "") + "/client/" + props.getProperty("token");
        slug = props.getProperty("slug");

        String text;
        try {
            text = new String(get(api + "/sync.txt", 3000, 10000), StandardCharsets.UTF_8);
        } catch (IOException error) {
            log("server unreachable (" + error.getMessage() + "); is Tailscale connected? Starting with the current files.");
            return;
        }

        Map<String, Setup> setups = new LinkedHashMap<>();
        List<Entry> files = new ArrayList<>();
        String agentFile = null, agentSha = null, serverName = null, serverAddress = null;
        for (String line : text.split("\n")) {
            String[] p = line.replace("\r", "").split("\t", -1);
            switch (p[0]) {
                case "server" -> { serverName = p[1]; serverAddress = p[2]; }
                case "agent" -> { agentFile = p[1]; agentSha = p[2]; }
                case "setup" -> setups.put(p[1], new Setup(p[1], p[2], p[3], p[4], "1".equals(p[7]), p[8]));
                case "file" -> {
                    if (!SAFE_NAME.matcher(p[3]).matches() || p[3].contains("..")) continue;
                    if (!p[2].equals("mods") && !SHARED_KINDS.contains(p[2])) continue;
                    files.add(new Entry(p[1], p[2], p[3], p[4], Long.parseLong(p[5]), List.of(p).subList(6, p.length)));
                }
                default -> { }
            }
        }
        loadHashCache();

        // 1. A newer agent is fetched now and used from the next launch on.
        if (agentFile != null && SAFE_NAME.matcher(agentFile).matches()) {
            Path target = root.resolve(agentFile);
            if (!verify(target, "sha256:" + agentSha)) {
                log("downloading agent " + agentFile);
                if (!download(List.of("agent/" + agentFile), target, "sha256:" + agentSha)) agentFile = null;
            }
        }

        // 2. This setup's mods (its own folder, so anything not listed is removed).
        Setup current = setups.get(setupId);
        if (current == null) {
            log("setup " + setupId + " is no longer on the server; its files are kept as they are");
        } else {
            Path modsDir = root.resolve("instances").resolve(setupId).resolve("mods");
            Files.createDirectories(modsDir);
            Files.createDirectories(modsDir.resolveSibling("extra-mods"));
            Set<String> wanted = new HashSet<>();
            for (Entry entry : files) {
                if (!entry.setup().equals(setupId) || !entry.kind().equals("mods")) continue;
                wanted.add(entry.name().toLowerCase(Locale.ROOT));
                Path target = modsDir.resolve(entry.name());
                if (verify(target, entry.hash())) continue;
                log("+ " + entry.name());
                if (!download(entry.urls(), target, entry.hash())) log("! could not download " + entry.name());
            }
            try (DirectoryStream<Path> dir = Files.newDirectoryStream(modsDir)) {
                for (Path file : dir) {
                    if (Files.isRegularFile(file) && !wanted.contains(file.getFileName().toString().toLowerCase(Locale.ROOT))) {
                        log("- " + file.getFileName());
                        Files.deleteIfExists(file);
                    }
                }
            }
        }

        // 3. Shader and resource packs live in shared folders: only files we put there are ever replaced or removed.
        Set<String> owned = new LinkedHashSet<>(readLines(root.resolve("owned.txt")));
        Set<String> desiredShared = new HashSet<>();
        for (Entry entry : files) {
            if (!SHARED_KINDS.contains(entry.kind())) continue;
            Path target = game.resolve(entry.kind()).resolve(entry.name());
            desiredShared.add(target.toString());
            if (!entry.setup().equals(setupId)) continue;
            if (Files.exists(target) && (!owned.contains(target.toString()) || verify(target, entry.hash()))) continue;
            log("+ " + entry.kind() + "/" + entry.name());
            if (download(entry.urls(), target, entry.hash())) owned.add(target.toString());
        }
        for (String path : new ArrayList<>(owned)) {
            Path file = Paths.get(path);
            if (file.startsWith(game) && !desiredShared.contains(path)) {
                log("- " + game.relativize(file));
                Files.deleteIfExists(file);
                owned.remove(path);
            }
        }
        writeLines(root.resolve("owned.txt"), owned);

        // 4. Launcher entries for every setup, in every game folder that has them.
        if (!setups.isEmpty()) refreshVersions(setups, agentFile);

        // 5. The server in the Multiplayer list; a shader preselected for Iris.
        if (serverAddress != null && !serverAddress.isBlank()) {
            try {
                ServersDat.ensure(game.resolve("servers.dat"), serverName, serverAddress);
            } catch (Exception error) {
                log("servers.dat not updated: " + error);
            }
        }
        if (current != null) {
            List<Entry> shaders = files.stream().filter(e -> e.setup().equals(setupId) && e.kind().equals("shaderpacks")).toList();
            if (shaders.size() == 1) selectShader(shaders.get(0).name());
            boolean voice = files.stream().anyMatch(e -> e.setup().equals(setupId) && e.kind().equals("mods")
                && e.name().toLowerCase(Locale.ROOT).startsWith("voicechat"));
            if (voice) fixVoiceEcho();
        }
        saveHashCache();

        // 6. The server switched worlds: preselect the new entry once, and warn
        //    a player who started an entry that can no longer join.
        Setup active = setups.values().stream().filter(Setup::active).findFirst().orElse(null);
        if (active == null) return;
        Path activeFile = root.resolve("active.txt");
        if (!active.id().equals(String.join("", readLines(activeFile)).trim())) {
            touchProfile(game.resolve("launcher_profiles.json"), active.vid());
            writeLines(activeFile, List.of(active.id()));
        }
        if (current != null && !current.active()) {
            log("this entry is not the server's current world; the server is on " + active.label());
            if (askToSwitch(current, active, serverName)) {
                touchProfile(game.resolve("launcher_profiles.json"), active.vid());
                log("closing so the player can start " + active.label());
                log.close();
                System.exit(0);
            }
        }
    }

    /**
     * Asks whether to close the game and start the right entry. The window
     * runs in its own short-lived process, so the game's graphics never share
     * a process with it. Returns false (play on) when no window can be shown.
     */
    boolean askToSwitch(Setup current, Setup active, String serverName) {
        if (Boolean.getBoolean("mcmanager.noDialog") || !System.getProperty("os.name", "").startsWith("Windows")) return false;
        try {
            Path self = Paths.get(Agent.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            Path javaw = Paths.get(System.getProperty("java.home"), "bin", "javaw.exe");
            if (!Files.exists(javaw)) javaw = javaw.resolveSibling("java.exe");
            Process dialog = new ProcessBuilder(javaw.toString(), "-cp", self.toString(), "mcmanager.agent.SwitchDialog",
                serverName == null ? "The server" : serverName, current.label(), active.label()).start();
            if (!dialog.waitFor(10, java.util.concurrent.TimeUnit.MINUTES)) {
                dialog.destroy();
                return false;
            }
            return dialog.exitValue() == 10;
        } catch (Exception error) {
            log("could not show the switch prompt: " + error);
            return false;
        }
    }

    /**
     * Simple Voice Chat has no echo cancellation: with speakers and voice
     * activation, a player's mic sends everyone's voice straight back to them.
     * Once per player, an existing voice setup is switched to push-to-talk
     * (Caps Lock by default; they can switch back in the voice settings). A
     * "Stereo Mix" style loopback device picked as the microphone sends all
     * game sound out, so it is always reset to the default microphone.
     */
    void fixVoiceEcho() {
        Path file = game.resolve("config").resolve("voicechat").resolve("voicechat-client.properties");
        Path marker = root.resolve("voice-ptt-applied.txt");
        try {
            if (!Files.exists(file)) {
                // New players choose push-to-talk or voice activation in the mod's first-run screen.
                if (!Files.exists(marker)) Files.writeString(marker, "new player\n");
                return;
            }
            boolean once = !Files.exists(marker);
            List<String> lines = new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8));
            boolean changed = false;
            for (int i = 0; i < lines.size(); i++) {
                String line = lines.get(i);
                if (once && line.equals("microphone_activation_type=VOICE")) {
                    lines.set(i, "microphone_activation_type=PTT");
                    log("voice chat switched to push-to-talk (stops echo through speakers)");
                    changed = true;
                } else if (line.startsWith("microphone=") && isLoopbackDevice(line.substring(11))) {
                    lines.set(i, "microphone=");
                    log("voice chat microphone was a loopback device (" + line.substring(11) + "); using the default microphone");
                    changed = true;
                }
            }
            if (changed) writeLines(file, lines);
            if (once) Files.writeString(marker, "applied\n");
        } catch (IOException error) {
            log("voice chat settings not checked: " + error);
        }
    }

    static boolean isLoopbackDevice(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.contains("stereo mix") || n.contains("what u hear") || n.contains("wave out mix") || n.contains("loopback");
    }

    /**
     * Picks our shader for Iris when the player has none selected, or when the
     * selected pack is missing or not a shader pack (Iris then silently renders
     * without shaders). A working pack the player chose, or shaders they turned
     * off, are left alone. Other Iris settings are kept.
     */
    void selectShader(String ours) throws IOException {
        if (!isShaderPack(game.resolve("shaderpacks").resolve(ours))) return; // ours didn't download
        Path iris = game.resolve("config").resolve("iris.properties");
        Properties props = new Properties();
        if (Files.exists(iris)) {
            try (InputStream in = Files.newInputStream(iris)) {
                props.load(in);
            }
        }
        String current = props.getProperty("shaderPack", "").trim();
        if (!current.isEmpty() && isShaderPack(game.resolve("shaderpacks").resolve(current))) return;
        if (!current.isEmpty()) log("shader pack " + current + " is missing or broken; switching to " + ours);
        props.setProperty("shaderPack", ours);
        props.setProperty("enableShaders", "true");
        Files.createDirectories(iris.getParent());
        try (OutputStream out = Files.newOutputStream(iris)) {
            props.store(out, "Iris settings (shader selected by the server's game sync)");
        }
        log("selected shader " + ours);
    }

    /** A shader pack is a folder or zip that contains a shaders/ directory. */
    static boolean isShaderPack(Path pack) {
        if (Files.isDirectory(pack)) return Files.isDirectory(pack.resolve("shaders"));
        if (!Files.isRegularFile(pack)) return false;
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(pack.toFile())) {
            return zip.stream().anyMatch(entry -> entry.getName().startsWith("shaders/"));
        } catch (IOException notAZip) {
            return false;
        }
    }

    void refreshVersions(Map<String, Setup> setups, String agentFile) throws IOException {
        Path stateFile = root.resolve("versions.txt");
        Map<String, String> state = new LinkedHashMap<>();
        Set<Path> games = new LinkedHashSet<>();
        games.add(game);
        for (String line : readLines(stateFile)) {
            String[] p = line.split("\t", -1);
            if (p.length < 3) continue;
            state.put(p[0] + "\t" + p[2], p[1]);
            if (Files.isDirectory(Paths.get(p[2]))) games.add(Paths.get(p[2]));
        }
        Map<String, String> templates = new HashMap<>();
        Map<String, String> next = new LinkedHashMap<>();
        for (Path dir : games) {
            for (Setup setup : setups.values()) {
                String key = setup.vid() + "\t" + dir;
                Path json = dir.resolve("versions").resolve(setup.vid()).resolve(setup.vid() + ".json");
                // A renamed world changes the label, which also refreshes the entry.
                String stamp = setup.hash() + "/" + Integer.toHexString(setup.label().hashCode());
                if (stamp.equals(state.get(key)) && Files.exists(json)) {
                    next.put(key, stamp);
                    continue;
                }
                if (agentFile == null) continue;
                String template = templates.get(setup.id());
                if (template == null) {
                    template = new String(get(api + "/version/" + setup.id() + ".json", 3000, 15000), StandardCharsets.UTF_8);
                    templates.put(setup.id(), template);
                }
                Files.createDirectories(json.getParent());
                Files.writeString(json, template.replace("@@CLIENT@@", fwd(root)).replace("@@GAME@@", fwd(dir)));
                setProfile(dir.resolve("launcher_profiles.json"), setup.vid(), setup.label());
                log("launcher entry " + setup.vid() + " updated in " + dir);
                next.put(key, stamp);
            }
            Path versions = dir.resolve("versions");
            if (Files.isDirectory(versions)) {
                try (DirectoryStream<Path> stream = Files.newDirectoryStream(versions, slug + "-*")) {
                    for (Path old : stream) {
                        String name = old.getFileName().toString();
                        if (setups.values().stream().noneMatch(s -> s.vid().equals(name))) {
                            log("removing old launcher entry " + name);
                            deleteTree(old);
                        }
                    }
                }
            }
        }
        List<String> lines = new ArrayList<>();
        next.forEach((key, hash) -> {
            String[] k = key.split("\t", 2);
            lines.add(k[0] + "\t" + hash + "\t" + k[1]);
        });
        writeLines(stateFile, lines);

        // Instances and agents nothing refers to any more.
        Path instances = root.resolve("instances");
        if (Files.isDirectory(instances)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(instances)) {
                for (Path dir : stream) if (!setups.containsKey(dir.getFileName().toString())) deleteTree(dir);
            }
        }
        if (agentFile != null) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(root, "agent-*.jar")) {
                for (Path jar : stream) {
                    if (jar.getFileName().toString().equals(agentFile)) continue;
                    try {
                        Files.deleteIfExists(jar);
                    } catch (IOException inUse) {
                        // The running agent is locked; it goes next time.
                    }
                }
            }
        }
    }

    // ------------------------------------------------------ launcher_profiles

    void setProfile(Path file, String vid, String label) throws IOException {
        String now = Instant.now().toString();
        // No "icon": launchers then show their Fabric look instead of the vanilla grass block.
        String entry = "\"" + vid + "\": {\"name\": " + jsonString(label) + ", \"type\": \"custom\", \"lastVersionId\": \"" + vid
            + "\", \"created\": \"" + now + "\", \"lastUsed\": \"" + now + "\"}";
        if (!Files.exists(file)) {
            Files.writeString(file, "{\"profiles\": {" + entry + "}, \"settings\": {}, \"version\": 3}");
            return;
        }
        String text = Files.readString(file);
        // Launchers may re-key profiles (SKLauncher uses random ids), so find ours by its version.
        int[] span = findProfileObject(text, vid);
        if (span != null) {
            // Keep the player's own settings; refresh the name and drop the old grass icon.
            String old = text.substring(span[0], span[1] + 1);
            String obj = Pattern.compile("(\"name\"\\s*:\\s*)\"(?:[^\"\\\\]|\\\\.)*\"").matcher(old)
                .replaceFirst(Matcher.quoteReplacement("\"name\": " + jsonString(label)));
            obj = obj.replaceAll("\\s*\"icon\"\\s*:\\s*\"[^\"]*\"\\s*,", "").replaceAll(",\\s*\"icon\"\\s*:\\s*\"[^\"]*\"", "");
            if (obj.equals(old)) return;
            text = text.substring(0, span[0]) + obj + text.substring(span[1] + 1);
        } else {
            Matcher profiles = Pattern.compile("\"profiles\"\\s*:\\s*\\{").matcher(text);
            if (!profiles.find()) {
                log("could not read " + file + "; pick the version " + vid + " by hand");
                return;
            }
            String rest = text.substring(profiles.end());
            String separator = rest.stripLeading().startsWith("}") ? "" : ", ";
            text = text.substring(0, profiles.end()) + entry + separator + rest;
        }
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(tmp, text);
        move(tmp, file);
    }

    /** Marks an entry as just used, so launchers list and preselect it first. */
    void touchProfile(Path file, String vid) {
        try {
            if (!Files.exists(file)) return;
            String text = Files.readString(file);
            int[] span = findProfileObject(text, vid);
            if (span == null) return;
            String old = text.substring(span[0], span[1] + 1);
            String stamp = "\"lastUsed\": \"" + Instant.now() + "\"";
            Matcher used = Pattern.compile("\"lastUsed\"\\s*:\\s*\"[^\"]*\"").matcher(old);
            String obj = used.find() ? used.replaceFirst(Matcher.quoteReplacement(stamp)) : "{" + stamp + ", " + old.substring(1);
            text = text.substring(0, span[0]) + obj + text.substring(span[1] + 1);
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.writeString(tmp, text);
            move(tmp, file);
        } catch (IOException error) {
            log("could not preselect " + vid + ": " + error);
        }
    }

    /** Start and end index of the profile object whose lastVersionId is vid, or null. */
    static int[] findProfileObject(String text, String vid) {
        Matcher m = Pattern.compile("\"lastVersionId\"\\s*:\\s*\"" + Pattern.quote(vid) + "\"").matcher(text);
        if (!m.find()) return null;
        int depth = 0;
        int start = -1;
        for (int i = m.start() - 1; i >= 0; i--) {
            char c = text.charAt(i);
            if (c == '}') depth++;
            else if (c == '{') {
                if (depth == 0) { start = i; break; }
                depth--;
            }
        }
        if (start < 0) return null;
        depth = 0;
        for (int j = start; j < text.length(); j++) {
            char c = text.charAt(j);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return new int[] { start, j };
        }
        return null;
    }

    static String jsonString(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32 || c > 126) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    // ------------------------------------------------------------ transfer

    byte[] get(String url, int connectMs, int readMs) throws IOException {
        HttpURLConnection connection = open(url, connectMs, readMs);
        try (InputStream in = connection.getInputStream()) {
            return in.readAllBytes();
        } finally {
            connection.disconnect();
        }
    }

    HttpURLConnection open(String url, int connectMs, int readMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
        connection.setConnectTimeout(connectMs);
        connection.setReadTimeout(readMs);
        connection.setRequestProperty("User-Agent", "mcmanager-agent/" + VERSION);
        connection.setRequestProperty("X-MCM-Agent", "agent/" + VERSION);
        int status = connection.getResponseCode();
        if (status != 200) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " from " + URI.create(url).getHost());
        }
        return connection;
    }

    /** Tries each URL (Modrinth's CDN, then the manager); keeps the file only if the hash matches. */
    boolean download(List<String> urls, Path target, String hash) throws IOException {
        Files.createDirectories(target.getParent());
        Path part = target.resolveSibling(target.getFileName() + ".part");
        for (String raw : urls) {
            String url;
            if (raw.startsWith("https://cdn.modrinth.com/")) url = raw;
            else if (raw.contains("://")) continue;
            else url = api + "/" + raw;
            try {
                HttpURLConnection connection = open(url, 5000, 30000);
                try (InputStream in = connection.getInputStream();
                     OutputStream out = Files.newOutputStream(part, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
                    in.transferTo(out);
                } finally {
                    connection.disconnect();
                }
                if (verify(part, hash)) {
                    move(part, target);
                    remember(target, hash);
                    return true;
                }
                log("checksum mismatch from " + url);
            } catch (IOException error) {
                log(url + " failed: " + error.getMessage());
            }
        }
        Files.deleteIfExists(part);
        return false;
    }

    static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicFailed) {
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // --------------------------------------------------------------- hashes

    /** True if the file exists and matches "algo:hex". Results are cached by size and mtime. */
    boolean verify(Path file, String spec) {
        if (spec == null || !Files.isRegularFile(file)) return false;
        try {
            String key = file + "|" + Files.size(file) + "|" + Files.getLastModifiedTime(file).toMillis();
            if (spec.equals(hashCache.get(key))) return true;
            String[] parts = spec.split(":", 2);
            String algorithm = switch (parts[0]) {
                case "sha1" -> "SHA-1";
                case "sha256" -> "SHA-256";
                case "sha512" -> "SHA-512";
                default -> null;
            };
            if (algorithm == null) return false;
            MessageDigest digest = MessageDigest.getInstance(algorithm);
            try (InputStream in = Files.newInputStream(file)) {
                byte[] buffer = new byte[1 << 16];
                for (int n; (n = in.read(buffer)) > 0;) digest.update(buffer, 0, n);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format("%02x", b));
            boolean ok = hex.toString().equalsIgnoreCase(parts[1]);
            if (ok) hashCache.put(key, spec);
            return ok;
        } catch (Exception error) {
            return false;
        }
    }

    void remember(Path file, String spec) {
        try {
            hashCache.put(file + "|" + Files.size(file) + "|" + Files.getLastModifiedTime(file).toMillis(), spec);
        } catch (IOException ignored) {
            // Re-hashed next time.
        }
    }

    void loadHashCache() {
        for (String line : readLines(root.resolve("hashes.txt"))) {
            int tab = line.lastIndexOf('\t');
            if (tab > 0) hashCache.put(line.substring(0, tab), line.substring(tab + 1));
        }
    }

    void saveHashCache() throws IOException {
        List<String> lines = new ArrayList<>();
        hashCache.forEach((key, spec) -> {
            if (Files.exists(Paths.get(key.substring(0, key.indexOf('|'))))) lines.add(key + "\t" + spec);
        });
        writeLines(root.resolve("hashes.txt"), lines);
    }

    // ---------------------------------------------------------------- utils

    static String fwd(Path path) {
        return path.toAbsolutePath().toString().replace('\\', '/');
    }

    static List<String> readLines(Path file) {
        try {
            return Files.readAllLines(file, StandardCharsets.UTF_8).stream().filter(l -> !l.isBlank()).toList();
        } catch (IOException missing) {
            return List.of();
        }
    }

    static void writeLines(Path file, Iterable<String> lines) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.write(tmp, lines, StandardCharsets.UTF_8);
        move(tmp, file);
    }

    static void deleteTree(Path path) throws IOException {
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
                for (Path child : stream) deleteTree(child);
            }
        }
        Files.deleteIfExists(path);
    }

    void openLog() throws IOException {
        Path file = root.resolve("sync.log");
        if (Files.exists(file) && Files.size(file) > 256 * 1024) move(file, root.resolve("sync.old.log"));
        log = new PrintWriter(Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND), true);
    }

    void log(String message) {
        String line = "[" + Instant.now() + "] " + message;
        if (log != null) log.println(line);
        System.out.println("[mcmanager] " + message);
    }
}
