package mcmanager.agent;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Adds (or updates) one entry in Minecraft's server list. servers.dat is an
 * uncompressed NBT compound with a "servers" list; every other tag is read and
 * written back unchanged.
 */
final class ServersDat {
    private ServersDat() {}

    record Tag(byte type, Object value) {}
    record ListTag(byte elementType, List<Object> items) {}

    static void ensure(Path file, String name, String address) throws IOException {
        Map<String, Tag> root = new LinkedHashMap<>();
        if (Files.exists(file)) {
            try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(Files.readAllBytes(file)))) {
                if (in.readByte() != 10) throw new IOException("servers.dat is not an NBT compound");
                in.readUTF();
                root = readCompound(in);
            }
        }
        Tag serversTag = root.get("servers");
        List<Object> servers = serversTag != null && serversTag.value() instanceof ListTag list ? list.items() : new ArrayList<>();

        for (Object item : servers) {
            @SuppressWarnings("unchecked")
            Map<String, Tag> server = (Map<String, Tag>) item;
            Tag ip = server.get("ip");
            Tag label = server.get("name");
            boolean sameIp = ip != null && address.equalsIgnoreCase(String.valueOf(ip.value()));
            boolean sameName = label != null && name.equals(String.valueOf(label.value()));
            if (!sameIp && !sameName) continue;
            if (sameIp && sameName) return;
            server.put("ip", new Tag((byte) 8, address));
            server.put("name", new Tag((byte) 8, name));
            write(file, root, servers);
            return;
        }
        Map<String, Tag> entry = new LinkedHashMap<>();
        entry.put("ip", new Tag((byte) 8, address));
        entry.put("name", new Tag((byte) 8, name));
        servers.add(0, entry);
        write(file, root, servers);
    }

    private static void write(Path file, Map<String, Tag> root, List<Object> servers) throws IOException {
        root.put("servers", new Tag((byte) 9, new ListTag((byte) 10, servers)));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeByte(10);
            out.writeUTF("");
            writeCompound(out, root);
        }
        if (Files.exists(file)) Files.copy(file, file.resolveSibling("servers.dat_old"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        Path tmp = file.resolveSibling("servers.dat.tmp");
        Files.write(tmp, bytes.toByteArray());
        Agent.move(tmp, file);
    }

    private static Map<String, Tag> readCompound(DataInputStream in) throws IOException {
        Map<String, Tag> map = new LinkedHashMap<>();
        for (byte type; (type = in.readByte()) != 0;) {
            String key = in.readUTF();
            map.put(key, new Tag(type, readPayload(in, type)));
        }
        return map;
    }

    private static Object readPayload(DataInputStream in, byte type) throws IOException {
        switch (type) {
            case 1: return in.readByte();
            case 2: return in.readShort();
            case 3: return in.readInt();
            case 4: return in.readLong();
            case 5: return in.readFloat();
            case 6: return in.readDouble();
            case 7: { byte[] a = new byte[in.readInt()]; in.readFully(a); return a; }
            case 8: return in.readUTF();
            case 9: {
                byte elementType = in.readByte();
                int length = in.readInt();
                List<Object> items = new ArrayList<>();
                for (int i = 0; i < length; i++) items.add(readPayload(in, elementType));
                return new ListTag(elementType, items);
            }
            case 10: return readCompound(in);
            case 11: { int[] a = new int[in.readInt()]; for (int i = 0; i < a.length; i++) a[i] = in.readInt(); return a; }
            case 12: { long[] a = new long[in.readInt()]; for (int i = 0; i < a.length; i++) a[i] = in.readLong(); return a; }
            default: throw new IOException("Unknown NBT tag " + type);
        }
    }

    private static void writeCompound(DataOutputStream out, Map<String, Tag> map) throws IOException {
        for (Map.Entry<String, Tag> entry : map.entrySet()) {
            out.writeByte(entry.getValue().type());
            out.writeUTF(entry.getKey());
            writePayload(out, entry.getValue().type(), entry.getValue().value());
        }
        out.writeByte(0);
    }

    @SuppressWarnings("unchecked")
    private static void writePayload(DataOutputStream out, byte type, Object value) throws IOException {
        switch (type) {
            case 1 -> out.writeByte((Byte) value);
            case 2 -> out.writeShort((Short) value);
            case 3 -> out.writeInt((Integer) value);
            case 4 -> out.writeLong((Long) value);
            case 5 -> out.writeFloat((Float) value);
            case 6 -> out.writeDouble((Double) value);
            case 7 -> { byte[] a = (byte[]) value; out.writeInt(a.length); out.write(a); }
            case 8 -> out.writeUTF((String) value);
            case 9 -> {
                ListTag list = (ListTag) value;
                byte elementType = list.items().isEmpty() && list.elementType() == 0 ? 10 : list.elementType();
                out.writeByte(elementType);
                out.writeInt(list.items().size());
                for (Object item : list.items()) writePayload(out, elementType, item);
            }
            case 10 -> writeCompound(out, (Map<String, Tag>) value);
            case 11 -> { int[] a = (int[]) value; out.writeInt(a.length); for (int v : a) out.writeInt(v); }
            case 12 -> { long[] a = (long[]) value; out.writeInt(a.length); for (long v : a) out.writeLong(v); }
            default -> throw new IOException("Unknown NBT tag " + type);
        }
    }
}
