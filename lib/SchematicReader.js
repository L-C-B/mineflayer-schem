const nbt = require('prismarine-nbt');
const Vec3 = require('vec3');

class SchematicReader {
    static async read(buffer) {
        try {
            const { parsed, type } = await nbt.parse(buffer);
            
            console.log('📦 NBT Type:', type);
            console.log('📦 Keys found:', Object.keys(parsed.value || parsed));

            const data = parsed.value || parsed;

            if (!data.Width || !data.Height || !data.Length || !data.Blocks) {
                console.error('❌ Schematic structure:');
                console.error(JSON.stringify(Object.keys(data), null, 2));
                throw new Error('The schematic does not have the expected format (MCEdit/WorldEdit)');
            }

            const width = data.Width.value;
            const height = data.Height.value;
            const length = data.Length.value;

            const baseBlocks = Array.from(data.Blocks.value);
            const metadata = data.Data ? Array.from(data.Data.value) : [];

            const addBlocks = data.AddBlocks ? Array.from(data.AddBlocks.value) : null;
            const blocks = addBlocks
                ? baseBlocks.map((id, index) => {
                    const addByte = addBlocks[index >> 1] || 0;
                    const high = (index & 1) === 0 ? (addByte & 0x0F) : ((addByte >> 4) & 0x0F);
                    return ((high << 8) | (id & 0xFF));
                })
                : baseBlocks;

            const readCoord = (key) => {
                if (!data[key]) return null;
                const value = data[key].value;
                return Number.isFinite(value) ? value : null;
            };

            const offsetCandidates = [
                { x: 'WEOffsetX', y: 'WEOffsetY', z: 'WEOffsetZ' },
                { x: 'OffsetX', y: 'OffsetY', z: 'OffsetZ' },
                { x: 'WEOriginX', y: 'WEOriginY', z: 'WEOriginZ' },
                { x: 'OriginX', y: 'OriginY', z: 'OriginZ' }
            ];

            let offset = null;
            for (const cand of offsetCandidates) {
                const ox = readCoord(cand.x);
                const oy = readCoord(cand.y);
                const oz = readCoord(cand.z);
                if (ox !== null || oy !== null || oz !== null) {
                    offset = new Vec3(ox || 0, oy || 0, oz || 0);
                    break;
                }
            }

            const schematic = {
                width,
                height,
                length,
                blocks,
                data: metadata,
                materials: data.Materials ? data.Materials.value : 'Alpha',
                offset: offset || new Vec3(0, 0, 0)
            };

            console.log('✅ Schematic parsed:');
            console.log(`   Dimensions: ${schematic.width}x${schematic.height}x${schematic.length}`);
            console.log(`   Blocks: ${schematic.blocks.length}`);
            console.log(`   Material: ${schematic.materials}`);

            return schematic;

        } catch (error) {
            console.error('❌ Detailed error:', error);
            throw new Error(`Error reading schematic: ${error.message}`);
        }
    }
}

module.exports = SchematicReader;
