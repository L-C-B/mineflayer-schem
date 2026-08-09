const Vec3 = require('vec3');

// Mapping explicite du facing selon la rotation ET l'axe d'origine du schéma
function mapFacingExplicit(facing, rotation, schematicFacing = 'south', targetFacing = 'south') {
    // Table de rotation Minecraft sens horaire
    const order = ['north', 'east', 'south', 'west'];
    let idx = order.indexOf(String(facing || '').toLowerCase());
    if (idx === -1) return facing;
    let schematicIdx = order.indexOf(String(schematicFacing || 'south').toLowerCase());
    let targetIdx = order.indexOf(String(targetFacing || 'south').toLowerCase());
    if (schematicIdx === -1) schematicIdx = 0; // défaut south
    if (targetIdx === -1) targetIdx = 0; // défaut south
    // Décalage relatif entre l'axe du schéma et la cible
    let baseRot = (targetIdx - schematicIdx + 4) % 4;
    // Décalage de la rotation utilisateur
    let rot = 0;
    if (rotation === 'rotate90') rot = 1;
    else if (rotation === 'rotate180') rot = 2;
    else if (rotation === 'rotate270') rot = 3;
    else if (rotation === 'inverse') rot = 2;
    // Additionne les décalages pour tourner dans le sens Minecraft
    return order[(idx + baseRot + rot) % 4];
}

function rotateBlockProperties(blockName, blockProperties, rotation = 'normal', schematicFacing = 'south', targetFacing = 'south') {
    if (!blockProperties) return blockProperties;
    // Rotation system disabled: preserve original block properties exactly.
    // Return a shallow copy to avoid accidental mutations downstream.
    return { ...blockProperties };
}


class Build {
        async run() {
            for (const action of this.actions) {
                if (action.type === 'place' && action.blockProperties && action.blockProperties.facing) {
                    const facingInitial = (this.blockProperties && this.blockProperties[action.state] && this.blockProperties[action.state].facing) || 'unknown';
                    const facingTransformed = action.blockProperties.facing;
                    console.log(`[BUILD][RUN] ${action.blockName} pos=(${action.pos.x},${action.pos.y},${action.pos.z}) | facing schéma: ${facingInitial} | facing transformé: ${facingTransformed}`);
                }
                // ... ici tu mettrais le code réel de placement (non inclus ici)
            }
        }
    constructor(schematic, world, at, bot, options = {}) {
        this.schematic = schematic;
        this.world = world;
        this.at = at;
        this.bot = bot;
        this.isPaused = false;
        this.isCancelled = false;
        this.options = options;

        this.min = at.clone();
        this.max = at.plus(new Vec3(
            schematic.width || 0,
            schematic.height || 0,
            schematic.length || 0
        ));

        this.actions = [];
        this.completedActions = [];
        this.statistics = {
            startTime: Date.now(),
            blocksPlaced: 0,
            blocksFailed: 0
        };

        console.log(`📦 Build initialized at ${at}`);
        console.log(`📐 Area: from ${this.min} to ${this.max}`);
        console.log(`🎮 Server version: ${bot.version}`);
        this.initializeBlocks();
    }

    initializeBlocks() {
        try {
            const mcData = require('minecraft-data')(this.bot.version);
            
            if (!mcData) {
                throw new Error(`minecraft-data does not support version ${this.bot.version}`);
            }

            
            this.blocks = {};
            this.items = {};
            this.blockData = {};
            this.blockProperties = {};

            const BLOCK_ID_MAP = {
                0: 'air', 1: 'stone', 2: 'grass_block', 3: 'dirt',
                4: 'cobblestone', 5: 'oak_planks', 6: 'oak_sapling',
                7: 'bedrock', 8: 'water', 9: 'water', 10: 'lava',
                11: 'lava', 12: 'sand', 13: 'gravel', 14: 'gold_ore',
                15: 'iron_ore', 16: 'coal_ore', 17: 'oak_log',
                18: 'oak_leaves', 19: 'sponge', 20: 'glass',
                21: 'lapis_ore', 22: 'lapis_block', 23: 'dispenser',
                24: 'sandstone', 25: 'note_block', 26: 'bed',
                27: 'powered_rail', 28: 'detector_rail', 29: 'sticky_piston',
                30: 'cobweb', 31: 'grass', 32: 'dead_bush',
                33: 'piston', 35: 'white_wool', 36: 'piston_head',
                37: 'dandelion', 38: 'poppy', 39: 'brown_mushroom',
                40: 'red_mushroom', 41: 'gold_block', 42: 'iron_block',
                43: 'double_stone_slab', 44: 'stone_slab', 45: 'bricks',
                46: 'tnt', 47: 'bookshelf', 48: 'mossy_cobblestone',
                49: 'obsidian', 50: 'torch', 51: 'fire',
                52: 'spawner', 53: 'oak_stairs', 54: 'chest',
                55: 'redstone_wire', 56: 'diamond_ore', 57: 'diamond_block',
                58: 'crafting_table', 59: 'wheat', 60: 'farmland',
                61: 'furnace', 62: 'furnace', 63: 'oak_sign',
                64: 'oak_door', 65: 'ladder', 66: 'rail',
                67: 'cobblestone_stairs', 68: 'oak_wall_sign', 69: 'lever',
                70: 'stone_pressure_plate', 71: 'iron_door', 72: 'oak_pressure_plate',
                73: 'redstone_ore', 74: 'redstone_ore', 75: 'redstone_torch',
                76: 'redstone_torch', 77: 'stone_button', 78: 'snow',
                79: 'ice', 80: 'snow_block', 81: 'cactus',
                82: 'clay', 83: 'sugar_cane', 84: 'jukebox',
                85: 'oak_fence', 86: 'pumpkin', 87: 'netherrack',
                88: 'soul_sand', 89: 'glowstone', 90: 'nether_portal',
                91: 'jack_o_lantern', 92: 'cake', 95: 'white_stained_glass',
                96: 'oak_trapdoor', 97: 'infested_stone', 98: 'stone_bricks',
                99: 'brown_mushroom_block', 100: 'red_mushroom_block',
                101: 'iron_bars', 102: 'glass_pane', 103: 'melon',
                104: 'pumpkin_stem', 105: 'melon_stem', 106: 'vine',
                107: 'oak_fence_gate', 108: 'brick_stairs', 109: 'stone_brick_stairs',
                110: 'mycelium', 111: 'lily_pad', 112: 'nether_bricks',
                113: 'nether_brick_fence', 114: 'nether_brick_stairs', 115: 'nether_wart',
                116: 'enchanting_table', 117: 'brewing_stand', 118: 'cauldron',
                119: 'end_portal', 120: 'end_portal_frame', 121: 'end_stone',
                122: 'dragon_egg', 123: 'redstone_lamp', 124: 'redstone_lamp',
                125: 'double_oak_slab', 126: 'oak_slab', 127: 'cocoa',
                128: 'sandstone_stairs', 129: 'emerald_ore', 130: 'ender_chest',
                131: 'tripwire_hook', 132: 'tripwire', 133: 'emerald_block',
                134: 'spruce_stairs', 135: 'birch_stairs', 136: 'jungle_stairs',
                137: 'command_block', 138: 'beacon', 139: 'cobblestone_wall',
                140: 'flower_pot', 141: 'carrots', 142: 'potatoes',
                143: 'oak_button', 144: 'skeleton_skull', 145: 'anvil',
                146: 'trapped_chest', 147: 'light_weighted_pressure_plate',
                148: 'heavy_weighted_pressure_plate', 149: 'comparator', 150: 'comparator',
                151: 'daylight_detector', 152: 'redstone_block', 153: 'nether_quartz_ore',
                154: 'hopper', 155: 'quartz_block', 156: 'quartz_stairs',
                157: 'activator_rail', 158: 'dropper', 159: 'white_terracotta',
                160: 'white_stained_glass_pane', 161: 'acacia_leaves', 162: 'acacia_log',
                163: 'acacia_stairs', 164: 'dark_oak_stairs', 165: 'slime_block',
                166: 'barrier', 167: 'iron_trapdoor', 168: 'prismarine',
                169: 'sea_lantern', 170: 'hay_block', 171: 'white_carpet',
                172: 'terracotta', 173: 'coal_block', 174: 'packed_ice',
                175: 'sunflower', 176: 'white_banner', 177: 'white_wall_banner',
                178: 'daylight_detector', 179: 'red_sandstone', 180: 'red_sandstone_stairs',
                181: 'double_red_sandstone_slab', 182: 'red_sandstone_slab',
                183: 'spruce_fence_gate', 184: 'birch_fence_gate', 185: 'jungle_fence_gate',
                186: 'dark_oak_fence_gate', 187: 'acacia_fence_gate', 188: 'spruce_fence',
                189: 'birch_fence', 190: 'jungle_fence', 191: 'dark_oak_fence',
                192: 'acacia_fence', 193: 'spruce_door', 194: 'birch_door',
                195: 'jungle_door', 196: 'acacia_door', 197: 'dark_oak_door',
                198: 'end_rod', 199: 'chorus_plant', 200: 'chorus_flower',
                201: 'purpur_block', 202: 'purpur_pillar', 203: 'purpur_stairs',
                204: 'double_purpur_slab', 205: 'purpur_slab', 206: 'end_stone_bricks',
                207: 'beetroots', 208: 'grass_path', 209: 'end_gateway',
                210: 'repeating_command_block', 211: 'chain_command_block',
                212: 'frosted_ice', 213: 'magma_block', 214: 'nether_wart_block',
                215: 'red_nether_bricks', 216: 'bone_block', 217: 'structure_void',
                218: 'observer', 219: 'white_shulker_box', 220: 'orange_shulker_box',
                221: 'magenta_shulker_box', 222: 'light_blue_shulker_box',
                223: 'yellow_shulker_box', 224: 'lime_shulker_box', 225: 'pink_shulker_box',
                226: 'gray_shulker_box', 227: 'light_gray_shulker_box',
                228: 'cyan_shulker_box', 229: 'purple_shulker_box', 230: 'blue_shulker_box',
                231: 'brown_shulker_box', 232: 'green_shulker_box', 233: 'red_shulker_box',
                234: 'black_shulker_box', 235: 'white_glazed_terracotta',
                251: 'white_concrete', 252: 'white_concrete_powder'
            };

            const blocks = this.schematic.blocks || [];
            const palette = this.schematic.palette || null;
            const blockDataArray = this.schematic.data || [];
            const uniqueBlocks = new Set();

            const BlockClass = (() => {
                try { return require('prismarine-block')(this.bot.version); } catch (e) { return null; }
            })();

            for (let i = 0; i < blocks.length; i++) {
                const paletteIndex = blocks[i];
                const metadata = blockDataArray[i] || 0;

                let blockName = 'stone';
                let recordedId = paletteIndex;
                let blockProperties = null;

                if (Array.isArray(palette) && palette.length > 0) {
                    const stateId = palette[paletteIndex] || 0;
                    recordedId = stateId;
                    if (BlockClass && typeof BlockClass.fromStateId === 'function') {
                        try {
                            const blockObj = BlockClass.fromStateId(stateId, 0);
                            if (blockObj && blockObj.name) blockName = blockObj.name;
                            if (blockObj && typeof blockObj.getProperties === 'function') {
                                blockProperties = blockObj.getProperties();
                            }
                        } catch (e) {
                            // fallback to heuristic below
                        }
                    }

                    // fallback heuristic when prismarine-block unavailable
                    if (!blockName || blockName === 'stone') {
                        const simpleId = (stateId && typeof stateId === 'number') ? (stateId >> 4) : paletteIndex;
                        blockName = BLOCK_ID_MAP[simpleId] || blockName;
                    }
                } else {
                    const blockId = paletteIndex;
                    blockName = BLOCK_ID_MAP[blockId] || 'stone';
                    recordedId = blockId;
                }

                uniqueBlocks.add(blockName);

                this.blocks[i] = {
                    id: recordedId,
                    name: blockName
                };

                this.blockData[i] = metadata;

                let item = mcData.itemsByName[blockName];

                if (!item) {
                    const variations = [
                        blockName.replace('_block', ''),
                        blockName + '_block',
                        blockName.replace('double_', ''),
                        blockName.replace('oak_', ''),
                        'oak_' + blockName
                    ];
                    
                    for (const variant of variations) {
                        item = mcData.itemsByName[variant];
                        if (item) {
                            break;
                        }
                    }
                }

                this.items[i] = item || mcData.itemsByName['stone'];
                // store detected block properties for later decoding (facing/half)
                this.blockProperties[i] = blockProperties || null;
            }


            this.updateActions();
            
        } catch (error) {
            console.error('❌ Error initializing blocks:', error.message);
            console.error('Stack:', error.stack);
        }
    }

    updateActions() {
        this.actions = [];
        const { width, height, length, blocks } = this.schematic;
        const schemOffset = this.schematic && this.schematic.offset ? this.schematic.offset : new Vec3(0, 0, 0);
        // Plus de rotation appliquée
        const rotation = 'normal';

        // Fonction utilitaire pour appliquer la rotation sur les coordonnées (x, z)
        function rotateCoords(x, z, w, l, rotation) {
            // w = width, l = length
            switch (rotation) {
                case 'rotate90':
                    return { x: l - 1 - z, z: x };
                case 'rotate180':
                    return { x: w - 1 - x, z: l - 1 - z };
                case 'rotate270':
                    return { x: z, z: w - 1 - x };
                case 'inverse':
                    // Inverse = flip X (pour compatibilité)
                    return { x: w - 1 - x, z };
                case 'normal':
                default:
                    return { x, z };
            }
        }


            // ...existing code...


        for (let y = 0; y < height; y++) {
            for (let z = 0; z < length; z++) {
                for (let x = 0; x < width; x++) {
                    // Appliquer la rotation sur (x, z)
                    const { x: rx, z: rz } = rotateCoords(x, z, width, length, rotation);
                    const index = rx + (rz * width) + (y * width * length);
                    const paletteIndex = blocks[index];

                    let blockName = this.blocks[index]?.name || 'stone';
                    let metadata = this.blockData[index] || 0;
                    let blockProperties = this.blockProperties[index] || null;
                    let recordedBlockId = this.blocks[index]?.id || paletteIndex;

                    // Prefer direct block decoding from schematic for reliable facing/half.
                    if (this.schematic && typeof this.schematic.getBlock === 'function') {
                        try {
                            const schemPos = new Vec3(rx, y, rz).plus(schemOffset);
                            const schemBlock = this.schematic.getBlock(schemPos);
                            if (schemBlock) {
                                if (schemBlock.name) blockName = schemBlock.name;
                                if (typeof schemBlock.stateId === 'number') recordedBlockId = schemBlock.stateId;
                                if (typeof schemBlock.metadata === 'number') metadata = schemBlock.metadata;
                                if (typeof schemBlock.getProperties === 'function') {
                                    const props = schemBlock.getProperties();
                                    if (props && Object.keys(props).length > 0) blockProperties = props;
                                }
                            }
                        } catch (e) {}
                    }

                    if (blockName === 'air') {
                        continue;
                    }


                    // Adapter les propriétés selon la rotation ET les axes schematicFacing/targetFacing
                    const rotatedProps = rotateBlockProperties(
                        blockName,
                        blockProperties,
                        rotation,
                        this.schematicFacing,
                        this.targetFacing
                    );


                    // Log direct à chaque action de placement pour les blocs orientables
                    if (blockProperties && blockProperties.facing) {
                        const facingInitial = blockProperties.facing;
                        const facingTransformed = rotatedProps.facing;
                        // Debug log removed: do not print per-action facing in production
                    }

                    this.actions.push({
                        type: 'place',
                        pos: this.at.offset(rx, y, rz),
                        state: index,
                        blockId: recordedBlockId,
                        blockName: blockName,
                        metadata: metadata,
                        blockProperties: rotatedProps
                    });
                }
            }
        }

        console.log(`📋 Actions generated: ${this.actions.length} blocks (rotation: ${rotation})`);
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }

    cancel() {
        this.isCancelled = true;
    }

    getProgress() {
        const total = this.actions.length + this.completedActions.length;
        return {
            total: total,
            completed: this.completedActions.length,
            remaining: this.actions.length,
            percentage: total > 0 ? ((this.completedActions.length / total) * 100).toFixed(2) : 0
        };
    }

    markActionComplete(action) {
        this.completedActions.push(action);
        this.statistics.blocksPlaced++;
    }

    getItemForState(stateId) {
        return this.items[stateId] || null;
    }

    getAvailableActions() {
        return this.actions;
    }
}

module.exports = Build;
module.exports.rotateBlockProperties = rotateBlockProperties;
module.exports.mapFacingExplicit = mapFacingExplicit;
