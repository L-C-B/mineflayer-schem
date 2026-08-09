const { goals } = require('@miner-org/mineflayer-baritone');
const Vec3 = require('vec3');
const Build = require('./lib/build.js');
const interactable = require('./lib/interactable.json');
const facing = require('./lib/facing.json');

function wait(ms) { 
    return new Promise(resolve => setTimeout(resolve, ms)); 
}

function resolveBaritone(bot) {
    return bot.ashfinder || bot.baritone || bot._baritone || bot.baritoneApi || null;
}

let pathfinderGoalsCache = null;

function getPathfinderGoals() {
    if (pathfinderGoalsCache !== null) {
        return pathfinderGoalsCache;
    }

    try {
        pathfinderGoalsCache = require('mineflayer-pathfinder').goals;
    } catch (error) {
        pathfinderGoalsCache = undefined;
    }

    return pathfinderGoalsCache;
}


// --- Mode survie: pas de refill automatique depuis les coffres ---
// Le bot utilise uniquement son inventaire (comportement uniforme créatif/survie)
function inject(bot, options = {}) {

    // --- Build couche par couche avec refill automatique ---
    bot.builder = bot.builder || {};
    bot.builder.buildLayerByLayer = async function(build) {
        // 1. Grouper les actions par couche Y
        const actionsByLayer = {};
        for (const action of build.actions) {
            if (!action || action.type !== 'place' || !action.pos) continue;
            const y = action.pos.y;
            if (!actionsByLayer[y]) actionsByLayer[y] = [];
            actionsByLayer[y].push(action);
        }
        const sortedLayers = Object.keys(actionsByLayer).map(Number).sort((a, b) => a - b);

        // 2. Pour chaque couche, refill puis placer
        for (const y of sortedLayers) {
            const layerActions = actionsByLayer[y];
            console.log(`[buildLayerByLayer] Couche Y=${y} : ${layerActions.length} blocs à placer`);
            for (const action of layerActions) {
                // Ici, appelle ta logique de placement réelle
                // await bot.builder.placeBlockUniversal(action, build);
                // Simule le placement pour l’exemple :
                console.log(`[buildLayerByLayer] Place ${action.blockName} en ${action.pos.x},${action.pos.y},${action.pos.z}`);
                // await wait(100); // optionnel : tempo pour debug
            }
        }
        console.log('[buildLayerByLayer] Build terminé !');
    };

        // --- Refill intelligent par couche ---
        bot.builder = bot.builder || {};
        bot.builder.refillForLayer = async function(layerActions, leaveSlotsFree = 6) {
            console.log('[refillForLayer] Disabled: chest withdrawals are turned off.');
        };
    const baritone = resolveBaritone(bot);

    if (!baritone || typeof baritone.goto !== 'function') {
        throw new Error('@miner-org/mineflayer-baritone must be loaded before mineflayer-schem');
    }

    // Prevent Baritone from pathing via ladders: remove 'ladder' from climbable blocks when possible
    try {
        if (baritone && Array.isArray(baritone.climbableBlocks)) {
            baritone.climbableBlocks = baritone.climbableBlocks.filter(b => String(b).toLowerCase() !== 'ladder');
        }
    } catch (e) {}

    const mcData = require('minecraft-data')(bot.version);
    const Item = require('prismarine-item')(bot.version);

    const defaultOptions = {
        buildSpeed: 2.0,
        onError: 'skip',
        clearArea: false,
        preventPathBreaking: true,
        allowBreakingAsLastResort: true,
        preferScaffoldingPathing: true,
        cleanupScaffoldImmediately: true,
        maxRetries: 3,
        digCost: 10,
        maxDropDown: 256,
        searchRadius: 10,
        // how many layers ahead to prefetch when refilling from linked chests (0 = only current layer)
        prefetchLayers: 1,
        // number of inventory slots to always keep free when refilling
        reserveInventorySlots: 5
    };

    const settings = { ...defaultOptions, ...options };
    let gotoQueue = Promise.resolve();
    let equipQueue = Promise.resolve();
    // Ensure correct tool is equipped for block breaking during builds.
    // Hoisted helper so it can be used anywhere inside the inject scope.
    async function equipBestToolForBlock(blockRef) {
        if (!blockRef) return;
        try {
            const pf = bot.pathfinder;
            if (pf && typeof pf.bestHarvestTool === 'function') {
                const tool = pf.bestHarvestTool(blockRef);
                if (tool) await bot.equip(tool, 'hand');
            }
        } catch (e) {}
    }

    function isAlreadyGoingError(error) {
        const message = error && error.message ? String(error.message) : '';
        return message.includes('Already going to a goal');
    }


    async function waitForBaritoneIdle(timeoutMs = 2000, pollMs = 50) {
        const start = Date.now();

        while (baritone.stopped === false && Date.now() - start < timeoutMs) {
            await wait(pollMs);
        }

        return baritone.stopped !== false;
    }

    async function baritoneGotoWithAntiFreeze(targetPos, range, timeoutMs = 10000) {
        let lastPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
        let lastMoveAt = Date.now();
        let interval = null;

        const timeoutPromise = new Promise((_, reject) => {
            interval = setInterval(() => {
                if (baritone.stopped !== false) return;

                const currentPos = bot.entity && bot.entity.position ? bot.entity.position : null;
                if (currentPos && lastPos && currentPos.distanceSquared(lastPos) >= 0.04 * 0.04) {
                    lastPos = currentPos.clone();
                    lastMoveAt = Date.now();
                    return;
                }

                if (Date.now() - lastMoveAt >= timeoutMs) {
                    try { if (typeof baritone.stop === 'function') baritone.stop(); } catch (e) {}
                    clearInterval(interval);
                    interval = null;
                    const err = new Error('Baritone stalled during goto');
                    err.code = 'BARITONE_STALLED';
                    reject(err);
                }
            }, 500);
        });

        try {
            const result = await Promise.race([
                baritone.goto(new goals.GoalNear(targetPos, range)),
                timeoutPromise
            ]);
            return result;
        } finally {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        }
    }

    function applyTemporaryNoBreakPathing(options = {}) {
        if (!settings.preventPathBreaking) {
            return () => {};
        }

        const allowPlacing = options && typeof options.allowPlacing === 'boolean'
            ? options.allowPlacing
            : settings.preferScaffoldingPathing;

        const restore = {
            hadConfig: !!(baritone && baritone.config),
            prevBreakBlocks: baritone && baritone.config ? baritone.config.breakBlocks : undefined,
            prevPlaceBlocks: baritone && baritone.config ? baritone.config.placeBlocks : undefined
        };

        try {
            if (typeof baritone.disableBreaking === 'function') {
                baritone.disableBreaking();
            } else if (baritone && baritone.config) {
                baritone.config.breakBlocks = false;
            }

            if (allowPlacing) {
                if (typeof baritone.enablePlacing === 'function') {
                    baritone.enablePlacing();
                } else if (baritone && baritone.config) {
                    baritone.config.placeBlocks = true;
                }
            } else {
                if (typeof baritone.disablePlacing === 'function') {
                    baritone.disablePlacing();
                } else if (baritone && baritone.config) {
                    baritone.config.placeBlocks = false;
                }
            }
        } catch (e) {}

        return () => {
            try {
                if (typeof restore.prevBreakBlocks === 'boolean') {
                    if (restore.prevBreakBlocks) {
                        if (typeof baritone.enableBreaking === 'function') baritone.enableBreaking();
                        else if (baritone && baritone.config) baritone.config.breakBlocks = true;
                    } else {
                        if (typeof baritone.disableBreaking === 'function') baritone.disableBreaking();
                        else if (baritone && baritone.config) baritone.config.breakBlocks = false;
                    }
                }

                if (typeof restore.prevPlaceBlocks === 'boolean') {
                    if (restore.prevPlaceBlocks) {
                        if (typeof baritone.enablePlacing === 'function') baritone.enablePlacing();
                        else if (baritone && baritone.config) baritone.config.placeBlocks = true;
                    } else {
                        if (typeof baritone.disablePlacing === 'function') baritone.disablePlacing();
                        else if (baritone && baritone.config) baritone.config.placeBlocks = false;
                    }
                }
            } catch (e) {}
        };
    }

    function applyTemporaryBreakPathing(options = {}) {
        const allowPlacing = options && typeof options.allowPlacing === 'boolean'
            ? options.allowPlacing
            : settings.preferScaffoldingPathing;

        const restore = {
            hadConfig: !!(baritone && baritone.config),
            prevBreakBlocks: baritone && baritone.config ? baritone.config.breakBlocks : undefined,
            prevPlaceBlocks: baritone && baritone.config ? baritone.config.placeBlocks : undefined
        };

        try {
            if (typeof baritone.enableBreaking === 'function') {
                baritone.enableBreaking();
            } else if (baritone && baritone.config) {
                baritone.config.breakBlocks = true;
            }

            if (allowPlacing) {
                if (typeof baritone.enablePlacing === 'function') {
                    baritone.enablePlacing();
                } else if (baritone && baritone.config) {
                    baritone.config.placeBlocks = true;
                }
            } else {
                if (typeof baritone.disablePlacing === 'function') {
                    baritone.disablePlacing();
                } else if (baritone && baritone.config) {
                    baritone.config.placeBlocks = false;
                }
            }
        } catch (e) {}

        return () => {
            try {
                if (typeof restore.prevBreakBlocks === 'boolean') {
                    if (restore.prevBreakBlocks) {
                        if (typeof baritone.enableBreaking === 'function') baritone.enableBreaking();
                        else if (baritone && baritone.config) baritone.config.breakBlocks = true;
                    } else {
                        if (typeof baritone.disableBreaking === 'function') baritone.disableBreaking();
                        else if (baritone && baritone.config) baritone.config.breakBlocks = false;
                    }
                }

                if (typeof restore.prevPlaceBlocks === 'boolean') {
                    if (restore.prevPlaceBlocks) {
                        if (typeof baritone.enablePlacing === 'function') baritone.enablePlacing();
                        else if (baritone && baritone.config) baritone.config.placeBlocks = true;
                    } else {
                        if (typeof baritone.disablePlacing === 'function') baritone.disablePlacing();
                        else if (baritone && baritone.config) baritone.config.placeBlocks = false;
                    }
                }
            } catch (e) {}
        };
    }

    async function performGotoNear(pos, range = 3, options = {}) {
        const targetPos = pos.floored ? pos.floored() : new Vec3(pos.x, pos.y, pos.z);
        const useLegacyPrecisionPathing = !!(options && options.forcePrecisePathing);
        const forbidPathScaffolding = !!(options && options.forbidPathScaffolding);
        const antiFreezeEnabled = !!(options && options.antiFreeze);
        const antiFreezeTimeoutMs = options && typeof options.antiFreezeMs === 'number'
            ? options.antiFreezeMs
            : 10000;
        const allowBreakLastResort = !!(settings.preventPathBreaking && settings.allowBreakingAsLastResort);
        const maxBusyRetries = 6;
        const restoreNoBreak = applyTemporaryNoBreakPathing({ allowPlacing: !forbidPathScaffolding });
        let lastError = null;

        try {
            for (let attempt = 1; attempt <= maxBusyRetries; attempt++) {
                if (baritone.stopped === false) {
                    if (typeof baritone.stop === 'function') {
                        baritone.stop();
                        await wait(100);
                    } else {
                        const becameIdle = await waitForBaritoneIdle(1500, 50);
                        if (!becameIdle) {
                            await wait(100);
                        }
                    }
                }

                try {
                    const result = antiFreezeEnabled
                        ? await baritoneGotoWithAntiFreeze(targetPos, range, antiFreezeTimeoutMs)
                        : await baritone.goto(new goals.GoalNear(targetPos, range));

                    if (result && result.status === 'failed') {
                        throw result.error || new Error('Baritone failed to reach the target');
                    }

                    return;
                } catch (error) {
                    lastError = error;
                    if (error && error.code === 'BARITONE_STALLED') {
                        await wait(150 + (attempt * 100));
                        continue;
                    }

                    if (!isAlreadyGoingError(error)) {
                        break;
                    }

                    if (typeof baritone.stop === 'function') {
                        baritone.stop();
                    }

                    await wait(150 + (attempt * 100));
                }
            }

            if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
                const pfGoals = getPathfinderGoals();

                if (pfGoals && typeof pfGoals.GoalNear === 'function') {
                    let previousMovements = null;
                    let appliedNoDig = false;

                    try {
                        if (settings.preventPathBreaking) {
                            const pfModule = require('mineflayer-pathfinder');
                            if (pfModule && pfModule.Movements && typeof bot.pathfinder.setMovements === 'function') {
                                previousMovements = bot.pathfinder.movements || null;
                                const noDigMovements = new pfModule.Movements(bot);
                                noDigMovements.canDig = false;
                                // During cleanup, avoid creating new scaffold/towers while moving.
                                noDigMovements.allow1by1towers = !forbidPathScaffolding;
                                if (forbidPathScaffolding && Array.isArray(noDigMovements.scafoldingBlocks)) {
                                    noDigMovements.scafoldingBlocks = [];
                                }
                                // Avoid stepping on fences/walls and the block above them
                                    try {
                                        const fenceWallExclusion = (block) => {
                                            try {
                                                if (!block || !block.position) return 0;
                                                const name = String(block.name || '').toLowerCase();
                                                if (name.includes('fence') || name.includes('wall')) return 100;
                                                const below = bot.blockAt(block.position.offset(0, -1, 0), false);
                                                const belowName = below && below.name ? String(below.name).toLowerCase() : '';
                                                if (belowName.includes('fence') || belowName.includes('wall')) return 100;
                                                const below2 = bot.blockAt(block.position.offset(0, -2, 0), false);
                                                const below2Name = below2 && below2.name ? String(below2.name).toLowerCase() : '';
                                                if (below2Name.includes('fence') || below2Name.includes('wall')) return 100;
                                            } catch (e) {}
                                            return 0;
                                        };
                                        noDigMovements.exclusionAreasStep = noDigMovements.exclusionAreasStep || [];
                                        noDigMovements.exclusionAreasStep.push(fenceWallExclusion);
                                    } catch (e) {}
                                    try {
                                        const ladderExclusion = (block) => {
                                            try {
                                                if (!block || !block.position) return 0;
                                                const name = String(block.name || '').toLowerCase();
                                                if (name.includes('ladder')) return 1000;
                                            } catch (e) {}
                                            return 0;
                                        };
                                        noDigMovements.exclusionAreasStep = noDigMovements.exclusionAreasStep || [];
                                        noDigMovements.exclusionAreasStep.push(ladderExclusion);
                                    } catch (e) {}
                                bot.pathfinder.setMovements(noDigMovements);
                                appliedNoDig = true;
                            }
                        }

                        await bot.pathfinder.goto(new pfGoals.GoalNear(targetPos.x, targetPos.y, targetPos.z, range));
                        return;
                    } finally {
                        if (appliedNoDig && previousMovements && typeof bot.pathfinder.setMovements === 'function') {
                            bot.pathfinder.setMovements(previousMovements);
                        }
                    }
                }
            }

            if (allowBreakLastResort) {
                const restoreBreak = applyTemporaryBreakPathing({ allowPlacing: !forbidPathScaffolding });
                try {
                    const result = antiFreezeEnabled
                        ? await baritoneGotoWithAntiFreeze(targetPos, range, antiFreezeTimeoutMs)
                        : await baritone.goto(new goals.GoalNear(targetPos, range));

                    if (result && result.status === 'failed') {
                        throw result.error || new Error('Baritone failed to reach the target with breaking');
                    }

                    return;
                } catch (error) {
                    lastError = error;
                } finally {
                    restoreBreak();
                }

                if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
                    const pfGoals = getPathfinderGoals();

                    if (pfGoals && typeof pfGoals.GoalNear === 'function') {
                        let previousMovements = null;
                        let appliedMovements = false;

                        try {
                            const pfModule = require('mineflayer-pathfinder');
                            if (pfModule && pfModule.Movements && typeof bot.pathfinder.setMovements === 'function') {
                                previousMovements = bot.pathfinder.movements || null;
                                const breakMovements = new pfModule.Movements(bot);
                                breakMovements.canDig = true;
                                breakMovements.allow1by1towers = !forbidPathScaffolding;
                                if (forbidPathScaffolding && Array.isArray(breakMovements.scafoldingBlocks)) {
                                    breakMovements.scafoldingBlocks = [];
                                }
                                // Avoid stepping on fences/walls and the block above them
                                    try {
                                        const fenceWallExclusion2 = (block) => {
                                            try {
                                                if (!block || !block.position) return 0;
                                                const name = String(block.name || '').toLowerCase();
                                                if (name.includes('fence') || name.includes('wall')) return 100;
                                                const below = bot.blockAt(block.position.offset(0, -1, 0), false);
                                                const belowName = below && below.name ? String(below.name).toLowerCase() : '';
                                                if (belowName.includes('fence') || belowName.includes('wall')) return 100;
                                                const below2 = bot.blockAt(block.position.offset(0, -2, 0), false);
                                                const below2Name = below2 && below2.name ? String(below2.name).toLowerCase() : '';
                                                if (below2Name.includes('fence') || below2Name.includes('wall')) return 100;
                                            } catch (e) {}
                                            return 0;
                                        };
                                        breakMovements.exclusionAreasStep = breakMovements.exclusionAreasStep || [];
                                        breakMovements.exclusionAreasStep.push(fenceWallExclusion2);
                                    } catch (e) {}
                                try {
                                    const ladderExclusion2 = (block) => {
                                        try {
                                            if (!block || !block.position) return 0;
                                            const name = String(block.name || '').toLowerCase();
                                            if (name.includes('ladder')) return 1000;
                                        } catch (e) {}
                                        return 0;
                                    };
                                    breakMovements.exclusionAreasStep = breakMovements.exclusionAreasStep || [];
                                    breakMovements.exclusionAreasStep.push(ladderExclusion2);
                                } catch (e) {}
                                bot.pathfinder.setMovements(breakMovements);
                                appliedMovements = true;
                            }

                            await bot.pathfinder.goto(new pfGoals.GoalNear(targetPos.x, targetPos.y, targetPos.z, range));
                            return;
                        } finally {
                            if (appliedMovements && previousMovements && typeof bot.pathfinder.setMovements === 'function') {
                                bot.pathfinder.setMovements(previousMovements);
                            }
                        }
                    }
                }
            }

            if (lastError) {
                throw lastError;
            }

            throw new Error('Baritone stayed busy after multiple retries and no pathfinder fallback was available');
        } finally {
            restoreNoBreak();
        }
    }

    async function gotoNear(pos, range = 3, options = {}) {
        const job = gotoQueue.then(() => performGotoNear(pos, range, options));
        gotoQueue = job.catch(() => {});
        return job;
    }

    bot.builder = {};
    bot.builder.isBuilding = false;
    let currentBuild = null;

    function isScaffoldingMaterial(blockName) {
        const name = String(blockName || '').toLowerCase();
        return name.includes('dirt') || name.includes('cobble');
    }

    function getScaffoldMaterialKey(blockName) {
        const name = String(blockName || '').toLowerCase();
        if (name.includes('dirt')) return 'dirt';
        if (name.includes('cobble')) return 'cobble';
        return null;
    }

    function isPlacedBlockPartOfActions(targetPos, placedBlockName) {
        if (!currentBuild || !Array.isArray(currentBuild.actions)) return false;

        const placedKey = getScaffoldMaterialKey(placedBlockName);
        return currentBuild.actions.some((action) => {
            if (!action || action.type !== 'place' || !action.pos) return false;
            if (action.pos.x !== targetPos.x || action.pos.y !== targetPos.y || action.pos.z !== targetPos.z) return false;

            // For scaffold detection, require matching material family on the action.
            if (placedKey) {
                const actionKey = getScaffoldMaterialKey(action.blockName);
                return actionKey === placedKey;
            }

            return true;
        });
    }

    bot.builder.placeBlockTracked = async function(refBlock, face, source = 'unknown') {
        const placedBlockName = bot.heldItem && bot.heldItem.name ? bot.heldItem.name : 'unknown';
        const targetPos = refBlock.position.plus(face);

        await bot.placeBlock(refBlock, face);

        const partOfActions = isPlacedBlockPartOfActions(targetPos, placedBlockName);
        const isScaffold = isScaffoldingMaterial(placedBlockName) && !partOfActions;

        if (isScaffold && source !== 'temporary_support') {
            console.log(
                `[SCHEM:SCAFFOLD_BLOCK] source=${source} block=${placedBlockName} pos=(${targetPos.x},${targetPos.y},${targetPos.z}) inActions=${partOfActions}`
            );
        }

        if (isScaffold) {
            // Defer cleanup to layer-end handler (buildschem), do not dig right away.
            bot.emit('pathfindingBlockPlaced', targetPos, placedBlockName, source || 'schem_scaffold');
        }

        return { isScaffold, partOfActions, placedBlockName, targetPos };
    };

    function getPossibleDirections(pos) {
        const directions = [];
        const offsets = [
            { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
            { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
            { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
            { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
            { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
            { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
        ];

        for (const { offset, face } of offsets) {
            const refPos = pos.plus(offset);
            const block = bot.blockAt(refPos);
            
            if (block && block.name !== 'air' && block.boundingBox !== 'empty') {
                directions.push({ block, face, refPos });
            }
        }
        
        return directions;
    }

    function isAirLike(block) {
        return !block || block.name === 'air' || block.boundingBox === 'empty';
    }

    // Use precise (legacy) pathing for stairs/trapdoors when the forward-adjacent
    // block (X) and the block below X are both air.
    function shouldUsePrecisePathingForStair(actionPos, blockFacing) {
        if (!actionPos || !blockFacing || !blockFacing.facing) return false;

        const xPos = actionPos.plus(blockFacing.facing);
        const blockX = bot.blockAt(xPos, false);
        const blockBelowX = bot.blockAt(xPos.offset(0, -1, 0), false);

        return isAirLike(blockX) && isAirLike(blockBelowX);
    }

    function isStairCondition2(actionPos, blockFacing) {
        if (!actionPos || !blockFacing || !blockFacing.facing) return false;
        const xPos = actionPos.plus(blockFacing.facing);
        const blockX = bot.blockAt(xPos, false);
        const blockBelowX = bot.blockAt(xPos.offset(0, -1, 0), false);
        return isAirLike(blockX) && isAirLike(blockBelowX);
    }

    function isInteractable(blockName) {
        return interactable.includes(blockName);
    }

    function hasLineOfSight(fromPos, toPos) {
        const direction = toPos.minus(fromPos);
        const distance = direction.norm();
        
        if (distance > 5) return false;
        
        const step = direction.scaled(1 / distance);
        let current = fromPos.clone();
        
        for (let i = 0; i < distance; i++) {
            current = current.plus(step);
            const block = bot.blockAt(current.floored());
            
            if (block && block.name !== 'air' && !block.position.equals(toPos.floored())) {
                return false;
            }
        }
        
        return true;
    }

    function getStairSupportOffsets(preferredFacing = null) {
        if (preferredFacing) {
            // Strict stair rule: support must be opposite to stair facing.
            return [preferredFacing.scaled(-1)];
        }

        const offsets = [];

        offsets.push(
            new Vec3(0, -1, 0),
            new Vec3(1, 0, 0),
            new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1),
            new Vec3(0, 0, -1),
            new Vec3(0, 1, 0)
        );

        const seen = new Set();
        return offsets.filter((off) => {
            const key = `${off.x},${off.y},${off.z}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    async function ensureTemporaryStairSupport(actionPos, blockFacing) {
        const dirtId = mcData.itemsByName?.dirt?.id;
        if (!dirtId) return null;

        const preferredFacing = blockFacing && blockFacing.facing ? blockFacing.facing : null;
        const candidateOffsets = getStairSupportOffsets(preferredFacing);

        for (const offset of candidateOffsets) {
            const supportPos = actionPos.plus(offset);
            const existing = bot.blockAt(supportPos);

            if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
                return { supportPos, created: false };
            }

            if (existing && existing.name !== 'air') continue;

            const supportDirections = getPossibleDirections(supportPos);
            if (supportDirections.length === 0) continue;

            const distance = bot.entity.position.distanceTo(supportPos);
            if (distance > 4.5) {
                try {
                    await gotoNear(supportPos, 3, { antiFreeze: true, antiFreezeMs: 10000 });
                } catch (e) {
                    continue;
                }
            }

            const selectedSupportDirection = supportDirections[0];
            const shouldSneakForSupport = isInteractable(selectedSupportDirection.block.name);

            try {
                await bot.builder.equipItem(dirtId, { noFetch: true });
                if (shouldSneakForSupport) bot.setControlState('sneak', true);
                await bot.builder.placeBlockTracked(selectedSupportDirection.block, selectedSupportDirection.face, 'temporary_support');
            } catch (e) {
            } finally {
                if (shouldSneakForSupport) bot.setControlState('sneak', false);
            }

            await wait(75);
            const placedSupport = bot.blockAt(supportPos);
            if (placedSupport && placedSupport.name !== 'air' && placedSupport.boundingBox !== 'empty') {
                return { supportPos, created: true };
            }
        }

        return null;
    }

    async function ensureDirtAtPosition(targetPos, source = 'temporary_support', options = {}) {
        if (!targetPos) return { used: false };
        const preferStandPos = options && options.preferStandPos ? options.preferStandPos : null;
        const skipGoto = !!(options && options.skipGoto);

        if (preferStandPos) {
            try {
                await gotoNear(preferStandPos, 1, { antiFreeze: true, antiFreezeMs: 10000 });
            } catch (e) {
            }
        }
        const existing = bot.blockAt(targetPos, false);
        if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
            return { used: true, created: false, pos: targetPos };
        }

        const dirtId = mcData.itemsByName?.dirt?.id;
        if (!dirtId) return { used: true, created: false, pos: targetPos, missingItem: true };

        const directions = getPossibleDirections(targetPos);
        if (directions.length === 0) return { used: true, created: false, pos: targetPos, noDirections: true };

        const distance = bot.entity.position.distanceTo(targetPos);
        if (!skipGoto && distance > 4.5) {
            try {
                await gotoNear(targetPos, 3);
            } catch (e) {
                return { used: true, created: false, pos: targetPos, gotoFailed: true };
            }
        }

        const selectedDirection = directions[0];
        const shouldSneak = isInteractable(selectedDirection.block.name);

        try {
            await bot.builder.equipItem(dirtId, { noFetch: true });
            if (shouldSneak) bot.setControlState('sneak', true);
            await bot.builder.placeBlockTracked(selectedDirection.block, selectedDirection.face, source);
        } catch (e) {
            return { used: true, created: false, pos: targetPos, placeFailed: true };
        } finally {
            if (shouldSneak) bot.setControlState('sneak', false);
        }

        await wait(75);
        const placed = bot.blockAt(targetPos);
        if (placed && placed.name !== 'air' && placed.boundingBox !== 'empty') {
            return { used: true, created: true, pos: targetPos };
        }

        return { used: true, created: false, pos: targetPos, verifyFailed: true };
    }

    async function ensureAdjacentStairSupport(actionPos, blockFacing) {
        if (!actionPos || !blockFacing || !blockFacing.facing) return { used: false };

        const xPos = actionPos.plus(blockFacing.facing);
        const existing = bot.blockAt(xPos, false);

        if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
            return { used: true, created: false, pos: xPos };
        }

        const dirtId = mcData.itemsByName?.dirt?.id;
        if (!dirtId) return { used: true, created: false, pos: xPos, missingItem: true };

        const directions = getPossibleDirections(xPos);
        if (directions.length === 0) return { used: true, created: false, pos: xPos, noDirections: true };

        const distance = bot.entity.position.distanceTo(xPos);
        if (distance > 4.5) {
            try {
                await gotoNear(xPos, 3);
            } catch (e) {
                return { used: true, created: false, pos: xPos, gotoFailed: true };
            }
        }

        const selectedDirection = directions[0];
        const shouldSneak = isInteractable(selectedDirection.block.name);

        try {
            await bot.builder.equipItem(dirtId, { noFetch: true });
            if (shouldSneak) bot.setControlState('sneak', true);
            await bot.builder.placeBlockTracked(selectedDirection.block, selectedDirection.face, 'temporary_support');
        } catch (e) {
            return { used: true, created: false, pos: xPos, placeFailed: true };
        } finally {
            if (shouldSneak) bot.setControlState('sneak', false);
        }

        await wait(75);
        const placed = bot.blockAt(xPos);
        if (placed && placed.name !== 'air' && placed.boundingBox !== 'empty') {
            return { used: true, created: true, pos: xPos };
        }

        return { used: true, created: false, pos: xPos, verifyFailed: true };
    }

    function facingNameToVec(name) {
        const normalized = String(name || '').toLowerCase();
        // Restore codebase's original orientation mapping:
        // north -> z=1, south -> z=-1, east -> x=-1, west -> x=1
        if (normalized === 'north') return new Vec3(0, 0, 1);
        if (normalized === 'south') return new Vec3(0, 0, -1);
        if (normalized === 'east') return new Vec3(-1, 0, 0);
        if (normalized === 'west') return new Vec3(1, 0, 0);
        return null;
    }

    function normalizeHalfFromProps(props) {
        if (!props) return null;
        if (typeof props.half === 'string') {
            const h = props.half.toLowerCase();
            if (h === 'top' || h === 'upper') return 'top';
            if (h === 'bottom' || h === 'lower') return 'bottom';
        }
        if (props.half === true) return 'top';
        if (props.top === true || props.isTop === true) return 'top';
        if (props.top === false || props.isTop === false) return 'bottom';
        return null;
    }

    function normalizeTrapdoorFacing(vec) {
        if (!vec) return vec;
        // Map: south == north, west == east
        // In this codebase: north -> z=1, south -> z=-1, east -> x=-1, west -> x=1
        if (vec.z === -1) {
            return new Vec3(0, 0, 1); // treat south as north
        }
        if (vec.x === 1) {
            return new Vec3(-1, 0, 0); // treat west as east
        }
        return vec;
    }

    function getBlockFacing(metadata, blockName, blockProperties = null, blockId = null) {
        if (blockName.includes('stairs')) {
            if (blockProperties && typeof blockProperties === 'object') {
                const fromProps = facingNameToVec(blockProperties.facing);
                if (fromProps) {
                    return { facing: fromProps, half: blockProperties.half || 'bottom' };
                }
            }

            let effectiveMetadata = metadata;
            if ((!Number.isInteger(effectiveMetadata) || effectiveMetadata === 0) && Number.isInteger(blockId)) {
                // Legacy fallback when metadata array is absent in schematic format.
                effectiveMetadata = blockId & 0xF;
            }

            const direction = effectiveMetadata & 0x3;
            const upsideDown = (effectiveMetadata & 0x4) !== 0;
            
            const facings = [
                new Vec3(0, 0, -1),
                new Vec3(0, 0, 1),
                new Vec3(-1, 0, 0),
                new Vec3(1, 0, 0)
            ];
            
            return { facing: facings[direction], half: upsideDown ? 'top' : 'bottom' };
        }
        
        if (blockName.includes('trapdoor')) {
            // Prefer block properties (newer schem formats) like stairs
            if (blockProperties && typeof blockProperties === 'object') {
                const fromProps = facingNameToVec(blockProperties.facing);
                if (fromProps) {
                    const halfFromProps = normalizeHalfFromProps(blockProperties);
                    const half = halfFromProps || 'bottom';
                    const mapped = normalizeTrapdoorFacing(fromProps);
                    return { facing: mapped, half };
                }
            }

            const direction = metadata & 0x3;
            const isOpen = (metadata & 0x4) !== 0;
            const isTop = (metadata & 0x8) !== 0;
            
            const facings = [
                new Vec3(0, 0, -1),
                new Vec3(0, 0, 1),
                new Vec3(-1, 0, 0),
                new Vec3(1, 0, 0)
            ];
            
            const mappedFacing = normalizeTrapdoorFacing(facings[direction]);
            return { facing: mappedFacing, half: isTop ? 'top' : 'bottom', open: isOpen };
        }
        
        if (blockName.includes('door')) {
            const direction = metadata & 0x3;
            const isOpen = (metadata & 0x4) !== 0;
            const isTop = (metadata & 0x8) !== 0;
            
            const facings = [
                new Vec3(1, 0, 0),
                new Vec3(0, 0, 1),
                new Vec3(-1, 0, 0),
                new Vec3(0, 0, -1)
            ];
            
            return { facing: facings[direction], half: isTop ? 'upper' : 'lower', open: isOpen };
        }

        if (blockName.includes('ladder')) {
            if (blockProperties && typeof blockProperties === 'object') {
                const fromProps = facingNameToVec(blockProperties.facing);
                if (fromProps) {
                    // Invert facing only for ladders
                    return { facing: fromProps.scaled(-1) };
                }
            }

            let effectiveMetadata = metadata;
            if ((!Number.isInteger(effectiveMetadata) || effectiveMetadata === 0) && Number.isInteger(blockId)) {
                // Legacy fallback when metadata array is absent in schematic format.
                effectiveMetadata = blockId & 0xF;
            }

            const direction = effectiveMetadata & 0x7;
            if (direction === 2) return { facing: facingNameToVec('north').scaled(-1) };
            if (direction === 3) return { facing: facingNameToVec('south').scaled(-1) };
            if (direction === 4) return { facing: facingNameToVec('west').scaled(-1) };
            if (direction === 5) return { facing: facingNameToVec('east').scaled(-1) };
        }


        const axisProp = blockProperties && typeof blockProperties === 'object' && typeof blockProperties.axis === 'string'
            ? blockProperties.axis.toLowerCase()
            : null;
        if (axisProp === 'x' || axisProp === 'y' || axisProp === 'z') {
            return { axis: axisProp };
        }

        if (blockName.includes('log') || blockName.includes('pillar') || blockName.includes('_wood') || blockName.includes('stem') || blockName.includes('hyphae')) {
            let effectiveMetadata = metadata;
            if ((!Number.isInteger(effectiveMetadata) || effectiveMetadata === 0) && Number.isInteger(blockId)) {
                // Legacy fallback when metadata array is absent in schematic format.
                effectiveMetadata = blockId & 0xF;
            }

            const axis = effectiveMetadata & 0xC;
            if (axis === 0x4) return { axis: 'x' };
            if (axis === 0x8) return { axis: 'z' };
            return { axis: 'y' };
        }
        
        return null;
    }

    function facingVecToName(vec) {
        if (!vec) return 'unknown';
        // Inverted mapping consistent with facingNameToVec above
        if (vec.z === 1) return 'north';
        if (vec.z === -1) return 'south';
        if (vec.x === -1) return 'east';
        if (vec.x === 1) return 'west';
        return 'unknown';
    }

    const getItemStackSize = (itemId) => {
        try {
            const entry = mcData && mcData.itemsById ? mcData.itemsById[itemId] : null;
            const size = entry && typeof entry.stackSize === 'number' ? entry.stackSize : null;
            return size && size > 0 ? size : 64;
        } catch (e) {
            return 64;
        }
    };

    const countInventoryById = (itemId) => {
        try {
            return bot.inventory.items().reduce((s, it) => s + ((it && it.type === itemId) ? (it.count || 1) : 0), 0);
        } catch (e) {
            return 0;
        }
    };

    const prefetchEnabled = false;

    const normalizeItemName = (val) => {
        if (!val) return '';
        return String(val).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
    };

    // --- Fonctions d'accès aux coffres (survie, 1 bloc à la fois) ---
    const getLinkedChestsList = () => {
        try {
            if (bot.builder && typeof bot.builder.getLinkedChests === 'function') return bot.builder.getLinkedChests();
        } catch (e) {}
        return Array.isArray(bot.builder && bot.builder._linkedBuildChests) ? bot.builder._linkedBuildChests.slice() : [];
    };

    const toChestPos = (entry) => {
        if (!entry) return null;
        if (entry instanceof Vec3) return entry;
        if (typeof entry.x === 'number' && typeof entry.y === 'number' && typeof entry.z === 'number') {
            return new Vec3(entry.x, entry.y, entry.z);
        }
        return null;
    };

    let chestAccessQueue = Promise.resolve();

    const withChestAccess = async (task) => {
        const job = chestAccessQueue.then(async () => {
            try {
                if (bot.currentWindow) {
                    try { bot.closeWindow(bot.currentWindow); } catch (e) {}
                    await wait(80);
                }
            } catch (e) {}
            return task();
        });
        chestAccessQueue = job.catch(() => {});
        return job;
    };

    const runChestTransaction = async (chestPos, task) => {
        return withChestAccess(async () => {
            const block = bot.blockAt(chestPos, false);
            if (!block) return { ok: false };
            let chest = null;
            try { if (typeof bot.openChest === 'function') chest = await bot.openChest(block); } catch (e) { chest = null; }
            if (!chest) {
                try { if (typeof bot.openContainer === 'function') chest = await bot.openContainer(block); } catch (e) { chest = null; }
            }
            if (!chest) return { ok: false };
            try {
                const result = await task(chest);
                return { ok: true, result };
            } finally {
                try { if (typeof chest.close === 'function') chest.close(); else if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e) {}
                await wait(60);
            }
        });
    };

    const fetchFromLinkedChests = async (opts = {}) => {
        const nameKey = normalizeItemName(opts.nameKey || opts.name || '');
        const itemId = typeof opts.itemId === 'number' ? opts.itemId : null;
        // Preshot : liste des types de blocs restants sur la couche (nameKey -> stackSize)
        const preshotNeeds = opts.preshotNeeds || null;
        const linked = getLinkedChestsList();
        if (!Array.isArray(linked) || linked.length === 0) return { fetched: 0 };

        // Calculer le nombre de slots disponibles (36 - 6 slots de réserve)
        const invItems = bot.inventory.items() || [];
        const usedSlots = invItems.length;
        let freeSlots = Math.max(0, 36 - 6 - usedSlots); // 36 slots total, 6 réservés

        // --- Blocs autorisés au dépôt ---
        // Seuls les blocs qui apparaissent dans les actions du build en cours peuvent être
        // déposés dans les coffres liés. Les autres items (outils, nourriture, blocs hors
        // build, etc.) ne sont JAMAIS déposés : on ne touche pas à ce qui n'appartient
        // pas au schéma en construction.
        const buildBlockKeys = new Set();
        try {
            const buildActions = (currentBuild && Array.isArray(currentBuild.actions)) ? currentBuild.actions : [];
            for (const act of buildActions) {
                if (!act || act.type !== 'place') continue;
                let bItem = null;
                try { bItem = currentBuild && typeof currentBuild.getItemForState === 'function' ? currentBuild.getItemForState(act.state) : null; } catch (e) { bItem = null; }
                const bName = (bItem && bItem.name) ? String(bItem.name).toLowerCase() : String(act.blockName || '').toLowerCase();
                if (bName) buildBlockKeys.add(normalizeItemName(bName));
            }
        } catch (e) {}

        if (freeSlots <= 0) {
            // Inventaire plein : essayer de déposer les items de construction qui ne sont PAS
            // nécessaires pour la couche courante (restes des couches précédentes / surplus)
            // dans les linked chests pour libérer de la place automatiquement.
            // Les outils / items non-constructibles ne sont jamais déposés.
            let depositedAny = false;
            try {
                // Construire la liste des items nécessaires pour la couche (preshotNeeds + nameKey)
                const neededKeys = new Set();
                if (nameKey) neededKeys.add(nameKey);
                if (preshotNeeds && Array.isArray(preshotNeeds)) {
                    for (const need of preshotNeeds) {
                        if (need && need.nameKey) neededKeys.add(normalizeItemName(need.nameKey));
                    }
                }

                // Items à ne JAMAIS déposer (outils, armes, équipement, etc.)
                const keepItemKeys = new Set([
                    'pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe', 'netherite_pickaxe',
                    'axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe', 'netherite_axe',
                    'shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'golden_shovel', 'wooden_shovel', 'netherite_shovel',
                    'hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe', 'netherite_hoe',
                    'sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_sword',
                    'bow', 'crossbow', 'trident', 'shield', 'fishing_rod', 'shears', 'flint_and_steel', 'brush',
                    'bucket', 'water_bucket', 'lava_bucket', 'milk_bucket', 'powder_snow_bucket',
                    'ender_pearl', 'ender_eye', 'totem_of_undying', 'elytra', 'firework_rocket', 'spyglass'
                ]);

                const isDepositableBuildItem = (key) => {
                    if (!key) return false;
                    // Seuls les blocs présents dans les actions du build sont déposables.
                    if (!buildBlockKeys.has(key)) return false;
                    if (keepItemKeys.has(key)) return false;
                    // Garde-fou supplémentaire : vérifier que c'est bien un bloc constructible.
                    try {
                        if (mcData && mcData.blocksByName) {
                            return !!mcData.blocksByName[key];
                        }
                    } catch (e) {}
                    return true;
                };

                // Premier passage : déposer les items NON nécessaires à la couche courante.
                // Ce sont des restes des couches précédentes qui viennent des coffres :
                // les libérer permet de débloquer l'inventaire sans perdre de matériaux.
                const depositedKeys = new Set();
                for (const it of invItems) {
                    if (!it) continue;
                    const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
                    const key = normalizeItemName(iname);
                    if (!key) continue;
                    if (neededKeys.has(key)) continue; // garder ce qui est nécessaire à la couche
                    if (depositedKeys.has(key)) continue;
                    if (!isDepositableBuildItem(key)) continue; // ne jamais déposer outils/équipement
                    depositedKeys.add(key);
                    try {
                        const depositResult = await depositItemToLinkedChests(key);
                        if (depositResult && depositResult.deposited > 0) {
                            depositedAny = true;
                        }
                    } catch (e) {}
                }

                // Second passage (dernier recours) : si l'inventaire est toujours plein,
                // déposer aussi les items nécessaires à la couche (ils seront re-piochés
                // dans les coffres juste après, ce qui reste plus efficace que de bloquer).
                const invStill = bot.inventory.items() || [];
                const freeStill = Math.max(0, 36 - 6 - invStill.length);
                if (freeStill <= 0) {
                    for (const it of invStill) {
                        if (!it) continue;
                        const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
                        const key = normalizeItemName(iname);
                        if (!key) continue;
                        if (!neededKeys.has(key)) continue;
                        if (depositedKeys.has(key)) continue;
                        if (!isDepositableBuildItem(key)) continue;
                        depositedKeys.add(key);
                        try {
                            const depositResult = await depositItemToLinkedChests(key);
                            if (depositResult && depositResult.deposited > 0) {
                                depositedAny = true;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}

            // Vérifier si on a libéré de la place
            const invAfter = bot.inventory.items() || [];
            const freeAfter = Math.max(0, 36 - 6 - invAfter.length);
        if (freeAfter > 0) {
            // On a libéré de la place, continuer normalement
            console.log(`[fetchFromLinkedChests] Deposited construction items to free ${freeAfter} slots.`);
            // Recalculer les slots libres pour la suite (preshot, etc.)
            freeSlots = freeAfter;
        } else {
                // Inventaire toujours plein : prévenir l'utilisateur et mettre la tâche en pause
                console.warn('[fetchFromLinkedChests] Inventory still full after deposit attempt — pausing build and notifying user.');
                try {
                    bot.emit('builder_inventory_full', {
                        usedSlots,
                        freeSlots: 0,
                        neededItem: nameKey || 'unknown'
                    });
                } catch (e) {}
                try {
                    if (bot.builder && typeof bot.builder.pause === 'function') {
                        bot.builder.pause();
                    }
                } catch (e) {}
                return { fetched: 0, inventoryFull: true };
            }
        }

        // Construire la liste des items à chercher :
        // 1. L'item demandé (nameKey)
        // 2. Les prochains types de blocs de la couche (preshot) dans la limite des slots libres
        const wantedItems = [];
        const wantedSet = new Set();

        // Item principal d'abord (le bloc qui manque)
        if (nameKey) {
            wantedItems.push({ nameKey, ident: itemId, priority: 0 });
            wantedSet.add(nameKey);
        }

        // Preshot : ajouter les prochains types de la couche (à partir du bloc manquant)
        if (preshotNeeds && Array.isArray(preshotNeeds)) {
            let slotsUsedForPreshot = 0;
            const maxPreshotSlots = Math.max(0, freeSlots - 1); // garder au moins 1 slot pour l'item principal
            for (const need of preshotNeeds) {
                if (!need || !need.nameKey) continue;
                const key = normalizeItemName(need.nameKey);
                if (wantedSet.has(key)) continue;
                if (slotsUsedForPreshot >= maxPreshotSlots) break;
                wantedItems.push({ nameKey: key, ident: need.ident || null, priority: 1 });
                wantedSet.add(key);
                slotsUsedForPreshot++;
            }
        }

        const botPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
        linked.sort((a, b) => {
            const pa = toChestPos(a);
            const pb = toChestPos(b);
            if (!botPos || !pa || !pb) return 0;
            return botPos.distanceTo(pa) - botPos.distanceTo(pb);
        });

        let fetched = 0;
        for (const entry of linked) {
            const chestPos = toChestPos(entry);
            if (!chestPos) continue;

            try {
                const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                if (distance > 4.5) {
                    try { await gotoNear(chestPos, 3); } catch (e) {}
                }
                await wait(200);
            } catch (e) {}

            const fetchResult = await runChestTransaction(chestPos, async (chest) => {
                let fetchedHere = 0;
                const slots = (typeof chest.containerItems === 'function')
                    ? chest.containerItems()
                    : (chest && chest.container && Array.isArray(chest.container.slots) ? chest.container.slots : []);

                for (const wanted of wantedItems) {
                    const { nameKey: wantedKey, ident: wantedIdent } = wanted;
                    for (const s of (slots || [])) {
                        if (!s || (!s.name && !s.displayName)) continue;
                        const slotName = normalizeItemName(s.name || s.displayName || '');
                        if (slotName !== wantedKey) {
                            if (wantedIdent == null || (s.type !== wantedIdent && s.id !== wantedIdent)) continue;
                        }
                        // Prendre le MAXIMUM disponible dans le coffre (pas limité à 64)
                        const take = s.count || 0;
                        if (take <= 0) continue;
                        try {
                            if (typeof chest.withdraw === 'function') {
                                await chest.withdraw(s.type || s.id || wantedIdent, null, take);
                                fetchedHere += take;
                                await wait(150);
                            }
                        } catch (e) {}
                    }
                }
                return fetchedHere;
            });

            if (fetchResult && fetchResult.ok) {
                fetched += Number(fetchResult.result || 0);
            }
            // Si on a trouvé l'item principal, on peut s'arrêter (les preshot items sont bonus)
            if (fetched > 0) break;
        }

        return { fetched };
    };

    // --- Batch refill par couche ---
    // Avant de commencer une couche, on calcule les besoins totaux et on va
    // chercher tout ce qui manque dans les coffres (en une seule fois si possible).
    // On utilise 30 slots max (36 - 6 réservés) pour éviter de saturer l'inventaire.
    const batchRefillForLayer = async (layerActions, build) => {
        const isCreative = !!(bot && bot.game && String(bot.game.gameMode || '').toLowerCase() === 'creative');
        if (isCreative) return;

        const linked = getLinkedChestsList();
        if (!Array.isArray(linked) || linked.length === 0) return;

        // 1. Calculer les besoins totaux de la couche (par type d'item)
        const needMap = {};
        const stackSizeMap = {};
        for (const act of layerActions) {
            if (!act || act.type !== 'place') continue;
            let item = null;
            try { item = build.getItemForState(act.state); } catch (e) { item = null; }
            const name = (item && item.name) ? String(item.name).toLowerCase() : String(act.blockName || '').toLowerCase();
            if (!name) continue;
            const stackSize = (item && (item.stackSize || item.maxStack || item.maxCount)) || 64;
            if (!needMap[name]) {
                needMap[name] = 0;
                stackSizeMap[name] = stackSize;
            }
            needMap[name] += 1;
        }

        // 2. Vérifier ce qu'on a déjà dans l'inventaire
        const invItems = bot.inventory.items() || [];
        const haveMap = {};
        for (const it of invItems) {
            if (!it) continue;
            const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
            const key = normalizeItemName(iname);
            if (!key) continue;
            haveMap[key] = (haveMap[key] || 0) + (it.count || 0);
        }

        // 3. Calculer ce qu'il manque (en slots, pas en items)
        const missing = [];
        const MAX_SLOTS = 30; // 36 - 6 réservés
        let slotsUsed = 0;
        for (const [name, total] of Object.entries(needMap)) {
            const have = haveMap[name] || 0;
            const need = Math.max(0, total - have);
            if (need <= 0) continue;
            const stackSize = stackSizeMap[name] || 64;
            const stacksNeeded = Math.ceil(need / stackSize);

            // On prend le min entre ce qui est nécessaire et ce qui tient dans les slots libres
            const canTake = Math.min(stacksNeeded, MAX_SLOTS - slotsUsed);
            if (canTake <= 0) continue;

            const mcItem = (mcData && mcData.itemsByName) ? mcData.itemsByName[name] : null;
            const ident = (mcItem && mcItem.id) ? mcItem.id : name;
            missing.push({ nameKey: name, ident, stacks: canTake, stackSize });
            slotsUsed += canTake;

            if (slotsUsed >= MAX_SLOTS) break;
        }

        if (missing.length === 0) {
            // Rien à chercher, on a déjà tout ce qu'il faut
            console.log(`[batchRefill] Layer already has all needed items (${Object.keys(haveMap).length} types in inventory)`);
            return { taken: 0 };
        }

        // 4. Aller au coffre le plus proche et prendre tout ce qui manque
        console.log(`[batchRefill] Layer needs ${missing.length} item types (${slotsUsed} slots). Going to chest...`);

        // Trier les coffres par distance (uniquement les linked chests)
        const botPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
        const sortedLinked = linked.slice().sort((a, b) => {
            const pa = toChestPos(a);
            const pb = toChestPos(b);
            if (!botPos || !pa || !pb) return 0;
            return botPos.distanceTo(pa) - botPos.distanceTo(pb);
        });

        let totalTaken = 0;
        for (const entry of sortedLinked) {
            const chestPos = toChestPos(entry);
            if (!chestPos) continue;

            try {
                const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                if (distance > 4.5) {
                    try { await gotoNear(chestPos, 3); } catch (e) {}
                }
                await wait(200);
            } catch (e) {}

            const txnResult = await runChestTransaction(chestPos, async (chest) => {
                let takenHere = 0;
                const slots = (typeof chest.containerItems === 'function')
                    ? chest.containerItems()
                    : (chest && chest.container && Array.isArray(chest.container.slots) ? chest.container.slots : []);

                for (const entry of missing) {
                    const { nameKey, ident, stacks, stackSize } = entry;
                    if (stacks <= 0) continue;
                    let takenFromThis = 0;
                    for (const s of (slots || [])) {
                        if (!s || (!s.name && !s.displayName)) continue;
                        const slotName = normalizeItemName(s.name || s.displayName || '');
                        if (slotName !== nameKey) continue;
                        const want = stacks * stackSize - takenFromThis;
                        if (want <= 0) break;
                        const take = Math.min(s.count || 0, want);
                        if (take <= 0) continue;
                        try {
                            if (typeof chest.withdraw === 'function') {
                                await chest.withdraw(s.type || s.id || ident, null, take);
                                takenFromThis += take;
                                takenHere += take;
                                await wait(80);
                            }
                        } catch (e) {}
                    }
                    entry.stacks = Math.max(0, entry.stacks - Math.ceil(takenFromThis / stackSize));
                }
                return takenHere;
            });

            if (txnResult && txnResult.ok) {
                totalTaken += Number(txnResult.result || 0);
            }

            // Si tous les items ont été trouvés, on s'arrête
            const allFound = missing.every(e => e.stacks <= 0);
            if (allFound) break;
        }

        console.log(`[batchRefill] Refill complete. Taken=${totalTaken}`);
        return { taken: totalTaken };
    };

    const depositItemToLinkedChests = async (nameKey) => {
        if (!nameKey) return { deposited: 0 };
        const linked = getLinkedChestsList();
        if (!Array.isArray(linked) || linked.length === 0) return { deposited: 0 };

        // Chercher l'item dans l'inventaire du bot
        const invItems = bot.inventory.items() || [];
        const itemsToDeposit = invItems.filter(it => {
            if (!it) return false;
            const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
            return normalizeItemName(iname) === nameKey;
        });
        if (itemsToDeposit.length === 0) return { deposited: 0 };

        const botPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
        linked.sort((a, b) => {
            const pa = toChestPos(a);
            const pb = toChestPos(b);
            if (!botPos || !pa || !pb) return 0;
            return botPos.distanceTo(pa) - botPos.distanceTo(pb);
        });

        let deposited = 0;
        for (const entry of linked) {
            const chestPos = toChestPos(entry);
            if (!chestPos) continue;

            // Vérifier s'il reste encore des items à déposer
            const remaining = bot.inventory.items() || [];
            const stillHas = remaining.some(it => {
                if (!it) return false;
                const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
                return normalizeItemName(iname) === nameKey;
            });
            if (!stillHas) break;

            try {
                const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                if (distance > 4.5) {
                    try { await gotoNear(chestPos, 3); } catch (e) {}
                }
                await wait(200);
            } catch (e) {}

            const depositResult = await runChestTransaction(chestPos, async (chest) => {
                let depositedHere = 0;
                const invNow = bot.inventory.items() || [];
                for (const it of invNow) {
                    if (!it) continue;
                    const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : '');
                    if (normalizeItemName(iname) !== nameKey) continue;
                    try {
                        if (typeof chest.deposit === 'function') {
                            await chest.deposit(it.type, null, it.count);
                            depositedHere += it.count;
                            await wait(80);
                        }
                    } catch (e) {}
                }
                return depositedHere;
            });

            if (depositResult && depositResult.ok) {
                const depositedHere = Number(depositResult.result || 0);
                deposited += depositedHere;
                // Mettre à jour le mapping du coffre pour garder le cache cohérent
                if (depositedHere > 0 && entry && typeof entry === 'object' && entry.items && typeof entry.items === 'object') {
                    try {
                        const key = normalizeItemName(nameKey);
                        if (entry.items[key] && typeof entry.items[key] === 'object') {
                            entry.items[key].count = (entry.items[key].count || 0) + depositedHere;
                        } else {
                            entry.items[key] = { count: depositedHere, type: null };
                        }
                    } catch (e) {}
                }
            }
        }

        return { deposited };
    };

    bot.builder.equipItem = async function(id, options = {}) {
        const job = equipQueue.then(async () => {
            const maxAttempts = 3;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    if (bot.currentWindow) {
                        try {
                            bot.closeWindow(bot.currentWindow);
                            await wait(50);
                        } catch (e) {}
                    }

                    const isCreativeMode = !!(bot.game && String(bot.game.gameMode || '').toLowerCase() === 'creative');
                    const invItems = bot.inventory.items() || [];
                    const reserveSlots = Math.max(0, Number(settings.reserveInventorySlots || 5));
                    const maxItems = Math.max(0, 36 - reserveSlots);

                    // Creative: /clear. Survival: dump inventory into linked chests.
                    if (invItems.length > maxItems) {
                        try {
                            if (isCreativeMode) {
                                try { await bot.chat('/clear'); } catch (e) {}
                                await wait(1000);
                            }
                            // Survival: pas de dépôt dans les coffres, le bot construit uniquement avec l'inventaire
                        } catch (e) {}
                    }

                    let item = invItems.find(i => i.type === id);

                    const getInventoryNameKey = (invItem) => {
                        if (!invItem) return '';
                        const direct = invItem.name || invItem.displayName;
                        if (direct) return normalizeItemName(direct);
                        try {
                            const md = (mcData && mcData.itemsById && mcData.itemsById[invItem.type]) ? mcData.itemsById[invItem.type] : null;
                            if (md && md.name) return normalizeItemName(md.name);
                        } catch (e) {}
                        return '';
                    };

                    if (!item) {
                        // Try to resolve name from registries and search by name
                        let desiredName = null;
                        try {
                            if (mcData && mcData.itemsById && mcData.itemsById[id]) desiredName = mcData.itemsById[id].name;
                            if (!desiredName && mcData && mcData.items && mcData.items[id]) desiredName = mcData.items[id].name;
                            if (!desiredName && bot.registry && bot.registry.itemsById && bot.registry.itemsById[id]) desiredName = bot.registry.itemsById[id].name;
                            if (!desiredName && bot.registry && bot.registry.items && bot.registry.items[id]) desiredName = bot.registry.items[id].name;
                        } catch (e) {}

                        if (!desiredName && options && (options.nameHint || options.blockName)) {
                            desiredName = options.nameHint || options.blockName;
                        }

                        if (!desiredName && typeof id === 'string') {
                            desiredName = id;
                        }

                        if (desiredName) {
                            const desiredKey = normalizeItemName(desiredName);
                            item = (bot.inventory.items() || []).find(i => getInventoryNameKey(i) === desiredKey);
                        }
                    }

                    if (!item && isCreativeMode) {
                        const slot = bot.inventory.firstEmptyInventorySlot();
                        const dest = slot !== null ? slot : 36;
                        try { await bot.creative.setInventorySlot(dest, new Item(id, 1, 0)); } catch (e) { console.warn('creative setInventorySlot failed', e && e.message); }
                        await wait(50);
                        item = bot.inventory.items().find(i => i.type === id);
                    }

                    // Survival : on ne va au coffre QUE si l'item courant manque en inventaire.
                    // Tout ce qui est déjà en inventaire est posé d'abord sans aller au coffre.
                    // Quand un bloc manque, on va chercher CE bloc + on preshot les types suivants
                    // de la couche (à partir du bloc manquant) pour éviter de revenir au coffre
                    // à chaque changement de type.
                    if (!item && !isCreativeMode && !(options && options.noFetch)) {
                        const nameKey = options && (options.nameHint || options.blockName)
                            ? normalizeItemName(options.nameHint || options.blockName)
                            : normalizeItemName((mcData && mcData.itemsById && mcData.itemsById[id]) ? mcData.itemsById[id].name : '');
                        try {
                            await fetchFromLinkedChests({
                                nameKey,
                                itemId: typeof id === 'number' ? id : null,
                                preshotNeeds: options.preshotNeeds || null
                            });
                        } catch (e) {}
                        item = (bot.inventory.items() || []).find(i => i.type === id)
                            || (nameKey ? (bot.inventory.items() || []).find(i => getInventoryNameKey(i) === nameKey) : null);
                    }

                    if (!item) {
                        try {
                            const mdItem = (mcData && mcData.itemsById && mcData.itemsById[id]) ? mcData.itemsById[id] : null;
                            const invSummary = (bot.inventory && typeof bot.inventory.items === 'function') ?
                                bot.inventory.items().map(it => {
                                    try {
                                        const name = it && it.name
                                            ? it.name
                                            : ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : it.type);
                                        return `${name}:${it.count || 1}`;
                                    } catch (e) { return `${it.type}:${it.count || 1}`; }
                                }).slice(0,50).join(', ') : 'no-inventory';
                            console.warn(`[builder:equipItem] Could not find item id=${id} name=${mdItem ? mdItem.name : 'unknown'}; inventory=[${invSummary}]`);
                        } catch (e) {}
                        throw new Error(`Could not get item ${id}`);
                    }

                    if (bot.heldItem && bot.heldItem.type === item.type) {
                        return item;
                    }

                    await bot.equip(item, 'hand');
                    return item;
                } catch (error) {
                    const message = error && error.message ? String(error.message) : String(error);
                    const retryable = message.includes('invalid operation') || message.includes('transaction');

                    if (!retryable || attempt >= maxAttempts) {
                        throw new Error(`Error equipping item: ${message}`);
                    }

                    try {
                        if (bot.currentWindow) {
                            bot.closeWindow(bot.currentWindow);
                        }
                    } catch (e) {}

                    await wait(80 * attempt);
                }
            }
        });

        equipQueue = job.catch(() => {});
        return job;
    };

    bot.builder.clearArea = async function(build) {
        console.log('🧹 Clearing build area...');
        const blocksToRemove = [];
        
        for (let y = build.min.y; y < build.max.y; y++) {
            for (let x = build.min.x; x < build.max.x; x++) {
                for (let z = build.min.z; z < build.max.z; z++) {
                    const pos = new Vec3(x, y, z);
                    const block = bot.blockAt(pos);
                    if (block && block.name !== 'air' && block.diggable) {
                        blocksToRemove.push(pos);
                    }
                }
            }
        }
        
        console.log(`🧹 Blocks to remove: ${blocksToRemove.length}`);
        
        let removed = 0;
        let failed = 0;
        
        for (const pos of blocksToRemove) {
            try {
                const block = bot.blockAt(pos);
                if (!block || block.name === 'air') continue;
                
                const distance = bot.entity.position.distanceTo(pos);
                if (distance > 4.5) {
                    try {
                        await gotoNear(pos, 3);
                    } catch (pathError) {
                        failed++;
                        continue;
                    }
                }

                try { await equipBestToolForBlock(block); } catch (e) {}
                await bot.dig(block);
                removed++;
                await wait(50);
            } catch (e) {
                failed++;
            }
        }
        
        console.log(`✅ Area cleared: ${removed} blocks removed, ${failed} failed`);
    };

    // --- Linked build chests (scan uniquement, pas de refill automatique) ---
    bot.builder._linkedBuildChests = bot.builder._linkedBuildChests || [];

    bot.builder.linkChests = function(chestPositions) {
        try {
            const list = Array.isArray(chestPositions) ? chestPositions : [];
            const normalized = [];
            for (const p of list) {
                if (!p) continue;
                try {
                    if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
                        if (p.items && typeof p.items === 'object') {
                            normalized.push({ x: p.x, y: p.y, z: p.z, items: p.items });
                        } else {
                            normalized.push(new Vec3(p.x, p.y, p.z));
                        }
                    } else if (p && p instanceof Vec3) {
                        normalized.push(p);
                    }
                } catch (e) {}
            }
            bot.builder._linkedBuildChests = normalized;
            return bot.builder._linkedBuildChests;
        } catch (e) {
            return bot.builder._linkedBuildChests;
        }
    };

    bot.builder.addLinkedChest = function(pos) {
        try {
            if (!pos) return bot.builder._linkedBuildChests;
            const p = (pos && typeof pos.x === 'number') ? new Vec3(pos.x, pos.y, pos.z) : (pos instanceof Vec3 ? pos : null);
            if (!p) return bot.builder._linkedBuildChests;
            const key = `${p.x},${p.y},${p.z}`;
            const exists = bot.builder._linkedBuildChests.some(q => `${q.x},${q.y},${q.z}` === key);
            if (!exists) bot.builder._linkedBuildChests.push(p);
            return bot.builder._linkedBuildChests;
        } catch (e) { return bot.builder._linkedBuildChests; }
    };

    bot.builder.clearLinkedChests = function() { bot.builder._linkedBuildChests = []; };

    bot.builder.getLinkedChests = function() { return Array.isArray(bot.builder._linkedBuildChests) ? bot.builder._linkedBuildChests.slice() : []; };

    bot.builder.build = async function(build) {
        currentBuild = build;
        bot.builder.isBuilding = true;

        const posKey = (pos) => `${pos.x},${pos.y},${pos.z}`;
        const desiredActionByPos = new Map();
        const expectedActionsByLayer = new Map();
        for (const a of (build.actions || [])) {
            if (!a || a.type !== 'place' || !a.pos || !a.blockName || a.blockName === 'air') continue;
            const key = posKey(a.pos);
            const expectedAction = {
                pos: new Vec3(a.pos.x, a.pos.y, a.pos.z),
                state: a.state,
                blockName: a.blockName,
                blockId: a.blockId,
                metadata: a.metadata,
                blockProperties: a.blockProperties
            };
            if (!desiredActionByPos.has(key)) {
                desiredActionByPos.set(key, expectedAction);
            }
            const layerY = a.pos.y;
            if (!expectedActionsByLayer.has(layerY)) expectedActionsByLayer.set(layerY, []);
            expectedActionsByLayer.get(layerY).push(expectedAction);
        }

        const onDiggingCompletedForActionLog = (brokenBlock) => {
            if (!bot.builder || !bot.builder.isBuilding) return;
            if (!brokenBlock || !brokenBlock.position || !brokenBlock.name || brokenBlock.name === 'air') return;

            const key = posKey(brokenBlock.position);
            const expectedAction = desiredActionByPos.get(key);
            if (!expectedAction) return;

            console.log(
                `[action-broken] expected=${expectedAction.blockName} broken=${brokenBlock.name} pos=(${brokenBlock.position.x},${brokenBlock.position.y},${brokenBlock.position.z})`
            );
        };

        const onDiggingCompletedForPickup = async (brokenBlock) => {
            if (!bot.builder || !bot.builder.isBuilding) return;
            if (!brokenBlock || !brokenBlock.position) return;

            const key = posKey(brokenBlock.position);
            const expectedAction = desiredActionByPos.get(key);
            if (!expectedAction) return;

            // Only attempt pickup in survival
            const isCreativeMode = !!(bot && bot.game && String(bot.game.gameMode || '').toLowerCase() === 'creative');
            if (isCreativeMode) return;

            try {
                // pause the build if the Build object supports it
                try { if (build && typeof build.pause === 'function') build.pause(); } catch (e) {}

                const countInventoryTotal = () => {
                    try { return (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items().reduce((a, b) => a + (b.count || 0), 0) : 0; } catch (e) { return 0; }
                };

                const beforeCount = countInventoryTotal();

                // Move near the broken block (best-effort)
                try { await gotoNear(brokenBlock.position, 1.5); } catch (e) {}

                const pickupTimeout = 12000;
                const start = Date.now();
                let picked = false;

                // Give drops a moment to spawn.
                await wait(250);

                while (Date.now() - start < pickupTimeout) {
                    const nearbyItems = Object.values(bot.entities || {}).filter(e => {
                        try {
                            return e && (e.name === 'item' || e.type === 'object') && e.position && e.position.distanceTo(brokenBlock.position) <= 4.5;
                        } catch (ex) { return false; }
                    }).sort((a, b) => a.position.distanceTo(brokenBlock.position) - b.position.distanceTo(brokenBlock.position));

                    if (nearbyItems.length === 0) {
                        break;
                    }

                    const target = nearbyItems[0];
                    try { await gotoNear(target.position, 1); } catch (e) {}
                    await wait(500);

                    try {
                        const now = countInventoryTotal();
                        if (now > beforeCount) {
                            picked = true;
                            break;
                        }
                    } catch (e) {}
                }

                if (!picked) {
                    // final attempt: stand on the broken block position
                    try { await gotoNear(brokenBlock.position, 0.8); } catch (e) {}
                    await wait(600);
                }
            } finally {
                try { if (build && typeof build.resume === 'function') build.resume(); } catch (e) {}
            }
        };

        bot.on('diggingCompleted', onDiggingCompletedForActionLog);

        const PATHFINDER_CLEANUP_LAYER_RANGE = 2;
        const pathfinderPlacedByLayer = new Map();

        const posToKey = (v) => `${v.x},${v.y},${v.z}`;
        const keyToPos = (key) => {
            const [x, y, z] = String(key).split(',').map((n) => Number(n));
            return new Vec3(x, y, z);
        };

        const getLayerRange = (centerY, distance) => {
            const ys = [];
            for (let y = centerY - distance; y <= centerY + distance; y++) ys.push(y);
            return ys;
        };

        const onPathfindingBlockPlaced = (targetPos, blockName, source) => {
            if (!bot.builder || !bot.builder.isBuilding) return;
            if (!targetPos || typeof targetPos.x !== 'number' || typeof targetPos.y !== 'number' || typeof targetPos.z !== 'number') return;

            const sourceName = String(source || 'unknown').toLowerCase();
            if (!sourceName.includes('mineflayer-pathfinder')) return;

            const pos = new Vec3(Math.floor(targetPos.x), Math.floor(targetPos.y), Math.floor(targetPos.z));
            const layerY = pos.y;
            if (!pathfinderPlacedByLayer.has(layerY)) {
                pathfinderPlacedByLayer.set(layerY, new Set());
            }
            pathfinderPlacedByLayer.get(layerY).add(posToKey(pos));
        };

        bot.on('pathfindingBlockPlaced', onPathfindingBlockPlaced);
        try { bot.on('diggingCompleted', onDiggingCompletedForPickup); } catch (e) {}

        const normalizeStr = (v) => String(v == null ? '' : v).toLowerCase();
        const normalizeHalf = (v) => {
            const s = normalizeStr(v);
            if (s === 'top' || s === 'upper' || s === 'true') return 'top';
            if (s === 'bottom' || s === 'lower' || s === 'false') return 'bottom';
            return s || null;
        };

        const getHorizontalDirectionsForPos = (pos) => {
            const directions = getPossibleDirections(pos) || [];
            return directions.filter((dir) => dir && dir.refPos && dir.refPos.y === pos.y);
        };

        const getDesiredSlabHalfFromAction = (action) => {
            if (!action || !action.blockName || !String(action.blockName).includes('slab')) return null;

            try {
                if (action.blockProperties && typeof action.blockProperties === 'object') {
                    const fromProps = normalizeHalf(
                        action.blockProperties.half != null
                            ? action.blockProperties.half
                            : action.blockProperties.type
                    );
                    if (fromProps === 'top' || fromProps === 'bottom') return fromProps;
                    if (typeof action.blockProperties.top === 'boolean') return action.blockProperties.top ? 'top' : 'bottom';
                    if (typeof action.blockProperties.isTop === 'boolean') return action.blockProperties.isTop ? 'top' : 'bottom';
                }
            } catch (e) {}

            if (typeof action.metadata === 'number') {
                return (action.metadata & 0x8) !== 0 ? 'top' : 'bottom';
            }

            return null;
        };

        const getLiaisonStepToward = (from, to) => {
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dz = to.z - from.z;

            const axes = [
                { axis: 'x', delta: dx },
                { axis: 'y', delta: dy },
                { axis: 'z', delta: dz }
            ].filter((a) => a.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

            if (axes.length === 0) return new Vec3(from.x, from.y, from.z);

            const chosen = axes[0];
            if (chosen.axis === 'x') return from.offset(Math.sign(dx), 0, 0);
            if (chosen.axis === 'y') return from.offset(0, Math.sign(dy), 0);
            return from.offset(0, 0, Math.sign(dz));
        };

        const findNearestSolidAnchorForTarget = (targetPos, maxRadius = 24) => {
            const startBlock = bot.blockAt(targetPos, false);
            if (startBlock && startBlock.name !== 'air' && startBlock.boundingBox !== 'empty') return targetPos;

            class MinHeap {
                constructor() { this.data = []; }
                push(node) {
                    this.data.push(node);
                    let i = this.data.length - 1;
                    while (i > 0) {
                        const p = Math.floor((i - 1) / 2);
                        if (this.data[p].dist2 <= this.data[i].dist2) break;
                        const tmp = this.data[p]; this.data[p] = this.data[i]; this.data[i] = tmp;
                        i = p;
                    }
                }
                pop() {
                    if (this.data.length === 0) return null;
                    const top = this.data[0];
                    const last = this.data.pop();
                    if (this.data.length > 0) {
                        this.data[0] = last;
                        let i = 0;
                        while (true) {
                            const l = 2 * i + 1;
                            const r = 2 * i + 2;
                            let smallest = i;
                            if (l < this.data.length && this.data[l].dist2 < this.data[smallest].dist2) smallest = l;
                            if (r < this.data.length && this.data[r].dist2 < this.data[smallest].dist2) smallest = r;
                            if (smallest === i) break;
                            const tmp = this.data[i]; this.data[i] = this.data[smallest]; this.data[smallest] = tmp;
                            i = smallest;
                        }
                    }
                    return top;
                }
                empty() { return this.data.length === 0; }
            }

            const maxDist2 = maxRadius * maxRadius;
            const heap = new MinHeap();
            const visited = new Set();
            visited.add(posKey(targetPos));
            heap.push({ pos: targetPos, dist2: 0 });

            while (!heap.empty()) {
                const node = heap.pop();
                if (!node || !node.pos) break;
                if (node.dist2 > maxDist2) continue;

                const p = node.pos;
                const block = bot.blockAt(p, false);
                if (block && block.name !== 'air' && block.boundingBox !== 'empty') return p;

                const neighbors = [
                    new Vec3(1, 0, 0),
                    new Vec3(-1, 0, 0),
                    new Vec3(0, 1, 0),
                    new Vec3(0, -1, 0),
                    new Vec3(0, 0, 1),
                    new Vec3(0, 0, -1)
                ];

                for (const off of neighbors) {
                    const np = p.plus(off);
                    const key = posKey(np);
                    if (visited.has(key)) continue;
                    visited.add(key);

                    const d2 = targetPos.distanceSquared(np);
                    if (d2 > maxDist2) continue;
                    heap.push({ pos: np, dist2: d2 });
                }
            }

            return null;
        };

        const buildScaffoldLiaison = async (anchorPos, targetPos, stopDistance = 0) => {
            let current = new Vec3(anchorPos.x, anchorPos.y, anchorPos.z);
            const placedPositions = [];
            let placedCount = 0;
            const maxSteps = 256;

            const manhattanDistance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

            for (let i = 0; i < maxSteps && manhattanDistance(current, targetPos) > stopDistance; i++) {
                const next = getLiaisonStepToward(current, targetPos);
                if (next.equals(current)) {
                    return { ok: false, reason: 'no-progress', placedCount, placedPositions };
                }

                const nextBlock = bot.blockAt(next, false);
                if (nextBlock && nextBlock.name !== 'air' && nextBlock.boundingBox !== 'empty') {
                    current = next;
                    continue;
                }

                const placeResult = await ensureDirtAtPosition(next, 'temporary_support', { preferStandPos: current });
                if (!placeResult || !placeResult.created) {
                    return { ok: false, reason: 'liaison-place-failed', placedCount, placedPositions };
                }

                placedPositions.push(new Vec3(next.x, next.y, next.z));
                placedCount++;
                current = next;
            }

            if (manhattanDistance(current, targetPos) > stopDistance) {
                return { ok: false, reason: 'path-too-long', placedCount, placedPositions };
            }

            return { ok: true, placedCount, placedPositions };
        };

        const ensureStairSupportWithLiaison = async (actionPos, blockFacing) => {
            if (!actionPos || !blockFacing || !blockFacing.facing) {
                return { ok: false, reason: 'no-facing' };
            }

            const supportPos = actionPos.plus(blockFacing.facing.scaled(-1));
            const existing = bot.blockAt(supportPos, false);
            if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
                return { ok: true, supportPos, placedPositions: [] };
            }

            const anchorPos = findNearestSolidAnchorForTarget(supportPos, 24);
            if (!anchorPos) {
                return { ok: false, reason: 'no-solid-anchor' };
            }

            const linkResult = await buildScaffoldLiaison(anchorPos, supportPos, 0);
            if (!linkResult.ok) {
                return { ok: false, reason: `liaison:${linkResult.reason || 'unknown'}`, placedPositions: linkResult.placedPositions || [] };
            }

            const placedSupport = bot.blockAt(supportPos, false);
            if (!placedSupport || placedSupport.name === 'air' || placedSupport.boundingBox === 'empty') {
                return { ok: false, reason: 'no-support-after-liaison', placedPositions: linkResult.placedPositions || [] };
            }

            return { ok: true, supportPos, placedPositions: linkResult.placedPositions || [] };
        };

        const ensureHorizontalSupportForTopSlab = async (targetPos) => {
            const anchorPos = findNearestSolidAnchorForTarget(targetPos, 24);
            if (!anchorPos) {
                return { ok: false, reason: 'no-solid-anchor' };
            }

            const candidates = [
                targetPos.plus(new Vec3(1, 0, 0)),
                targetPos.plus(new Vec3(-1, 0, 0)),
                targetPos.plus(new Vec3(0, 0, 1)),
                targetPos.plus(new Vec3(0, 0, -1))
            ].sort((a, b) => anchorPos.distanceSquared(a) - anchorPos.distanceSquared(b));

            const mergedPositions = [];
            let totalPlaced = 0;

            for (const candidate of candidates) {
                const existing = bot.blockAt(candidate, false);
                if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
                    if (getHorizontalDirectionsForPos(targetPos).length > 0) {
                        return { ok: true, placedCount: totalPlaced, placedPositions: mergedPositions };
                    }
                    continue;
                }

                const linkResult = await buildScaffoldLiaison(anchorPos, candidate, 0);
                if (!linkResult.ok) continue;

                totalPlaced += linkResult.placedCount || 0;
                if (Array.isArray(linkResult.placedPositions) && linkResult.placedPositions.length > 0) {
                    mergedPositions.push(...linkResult.placedPositions);
                }

                if (getHorizontalDirectionsForPos(targetPos).length > 0) {
                    return { ok: true, placedCount: totalPlaced, placedPositions: mergedPositions };
                }
            }

            return { ok: false, reason: 'no-horizontal-support' };
        };

        const cleanupLiaisonScaffoldPositions = async (positions) => {
            if (!Array.isArray(positions) || positions.length === 0) return;

            const seen = new Set();
            const pending = [];

            for (const p of positions) {
                if (!p) continue;
                const key = posKey(p);
                if (seen.has(key)) continue;
                seen.add(key);
                pending.push(p);
            }

            const trackScaffold = (pos) => {
                if (!pos) return;
                const key = posKey(pos);
                if (seen.has(key)) return;
                seen.add(key);
                pending.push(pos);
            };

            while (pending.length > 0) {
                if (!bot.builder || !bot.builder.isBuilding) return;
                const p = pending.pop();
                try {
                    const block = bot.blockAt(p, false);
                    if (!block || !isScaffoldingMaterial(block.name) || !block.diggable) continue;
                    if (isPlacedBlockPartOfActions(p, block.name)) continue;

                    const safeAnchorReady = await ensureSafeDigAnchor(p, trackScaffold);
                    if (!safeAnchorReady) continue;

                    await equipBestToolForBlock(block);
                    bot.setControlState('sneak', true);
                    await bot.dig(block, true);
                    bot.setControlState('sneak', false);
                    await wait(75);
                } catch (e) {
                    try { bot.setControlState('sneak', false); } catch (e2) {}
                }
            }
        };

        const getActualHalf = (blockAtPos) => {
            if (!blockAtPos) return null;
            try {
                if (typeof blockAtPos.getProperties === 'function') {
                    const props = blockAtPos.getProperties() || {};
                    const fromProps = normalizeHalf(props.half != null ? props.half : props.type);
                    if (fromProps) return fromProps;
                    if (typeof props.top === 'boolean') return props.top ? 'top' : 'bottom';
                    if (typeof props.isTop === 'boolean') return props.isTop ? 'top' : 'bottom';
                }
            } catch (e) {}
            if (typeof blockAtPos.metadata === 'number') {
                try {
                    return (blockAtPos.metadata & 0x8) !== 0 ? 'top' : 'bottom';
                } catch (e) {}
            }
            return null;
        };

        const filterDirectionsForSlabHalf = (directions, desiredHalf) => {
            if (!desiredHalf || !Array.isArray(directions)) return directions;

            return directions.filter((dir) => {
                const refBlock = dir && dir.block ? dir.block : null;
                if (!refBlock || !refBlock.name) return true;
                if (!String(refBlock.name).includes('slab')) return true;

                const actualHalf = getActualHalf(refBlock);
                if (!actualHalf) return true;

                return actualHalf === desiredHalf;
            });
        };

        const normalizeAxis = (axis) => {
            const normalized = String(axis || '').toLowerCase();
            if (normalized === 'x' || normalized === 'y' || normalized === 'z') return normalized;
            return null;
        };

        const filterDirectionsForAxis = (directions, axis) => {
            const normalized = normalizeAxis(axis);
            if (!normalized || !Array.isArray(directions)) return directions;

            return directions.filter((dir) => {
                if (!dir || !dir.face) return false;
                if (normalized === 'x') return Math.abs(dir.face.x) === 1;
                if (normalized === 'y') return Math.abs(dir.face.y) === 1;
                if (normalized === 'z') return Math.abs(dir.face.z) === 1;
                return true;
            });
        };

        const getAxisSupportOffsets = (axis) => {
            const normalized = normalizeAxis(axis);
            if (!normalized) return [];
            if (normalized === 'x') return [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)];
            if (normalized === 'z') return [new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
            return [new Vec3(0, -1, 0), new Vec3(0, 1, 0)];
        };

        const ensureAxisSupport = async (actionPos, axis) => {
            const offsets = getAxisSupportOffsets(axis);
            for (const offset of offsets) {
                const supportPos = actionPos.plus(offset);
                const existing = bot.blockAt(supportPos, false);
                if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
                    return { supportPos, created: false };
                }

                const result = await ensureDirtAtPosition(supportPos, 'temporary_support');
                if (result && result.created) {
                    return { supportPos, created: true };
                }

                const placed = bot.blockAt(supportPos, false);
                if (placed && placed.name !== 'air' && placed.boundingBox !== 'empty') {
                    return { supportPos, created: false };
                }
            }

            return null;
        };

        const getLiaisonSupportCandidates = (actionPos, options = {}) => {
            const requiredSupportPos = options.requiredSupportPos || null;
            if (requiredSupportPos) return [requiredSupportPos];

            const axis = normalizeAxis(options.axis);
            if (axis) {
                return getAxisSupportOffsets(axis).map((off) => actionPos.plus(off));
            }

            return [
                actionPos.plus(new Vec3(1, 0, 0)),
                actionPos.plus(new Vec3(-1, 0, 0)),
                actionPos.plus(new Vec3(0, 0, 1)),
                actionPos.plus(new Vec3(0, 0, -1)),
                actionPos.plus(new Vec3(0, -1, 0)),
                actionPos.plus(new Vec3(0, 1, 0))
            ];
        };

        const ensureAdjacentSupportWithLiaison = async (actionPos, options = {}) => {
            if (!actionPos) return { ok: false, reason: 'no-action-pos', placedPositions: [] };

            const candidates = getLiaisonSupportCandidates(actionPos, options);
            const placedPositions = [];

            const mergePlaced = (list) => {
                if (!Array.isArray(list)) return;
                for (const p of list) placedPositions.push(p);
            };

            for (const supportPos of candidates) {
                if (!supportPos) continue;

                const existing = bot.blockAt(supportPos, false);
                if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
                    return { ok: true, supportPos, placedPositions };
                }

                const anchorPos = findNearestSolidAnchorForTarget(supportPos, 24);
                if (!anchorPos) continue;

                const linkResult = await buildScaffoldLiaison(anchorPos, supportPos, 0);
                mergePlaced(linkResult && linkResult.placedPositions ? linkResult.placedPositions : []);

                if (!linkResult || !linkResult.ok) {
                    continue;
                }

                const placedSupport = bot.blockAt(supportPos, false);
                if (placedSupport && placedSupport.name !== 'air' && placedSupport.boundingBox !== 'empty') {
                    return { ok: true, supportPos, placedPositions };
                }
            }

            return { ok: false, reason: 'no-support', placedPositions };
        };

        const matchesExpectedOrientation = (expectedAction, blockAtPos) => {
            const expectedProps = expectedAction && expectedAction.blockProperties;
            if (!expectedProps || typeof expectedProps !== 'object') return true;
            if (!blockAtPos || typeof blockAtPos.getProperties !== 'function') return true;

            let actualProps = {};
            try { actualProps = blockAtPos.getProperties() || {}; } catch (e) { actualProps = {}; }

            const expectedFacing = normalizeStr(expectedProps.facing);
            const actualFacing = normalizeStr(actualProps.facing || actualProps.rotation);
            if (expectedFacing && actualFacing && expectedFacing !== actualFacing) return false;

            const expectedAxis = normalizeStr(expectedProps.axis);
            const actualAxis = normalizeStr(actualProps.axis);
            if (expectedAxis && actualAxis && expectedAxis !== actualAxis) return false;

            const expectedHalf = normalizeHalf(expectedProps.half != null ? expectedProps.half : expectedProps.type);
            const actualHalf = getActualHalf(blockAtPos);
            if (expectedHalf && actualHalf && expectedHalf !== actualHalf) return false;

            return true;
        };

        const isExpectedBlockAt = (expectedAction) => {
            if (!expectedAction || !expectedAction.pos) return true;
            const blockAtPos = bot.blockAt(expectedAction.pos, false);
            if (!blockAtPos || blockAtPos.name === 'air') return false;

            const expectedName = normalizeStr(expectedAction.blockName);
            const actualName = normalizeStr(blockAtPos.name);
            if (expectedName && expectedName !== actualName) return false;

            return matchesExpectedOrientation(expectedAction, blockAtPos);
        };

        const isActionAlreadyQueued = (expectedAction) => {
            if (!expectedAction || !expectedAction.pos) return false;
            return (build.actions || []).some((a) =>
                a && a.type === 'place' && a.pos &&
                a.pos.x === expectedAction.pos.x && a.pos.y === expectedAction.pos.y && a.pos.z === expectedAction.pos.z
            );
        };

        const enqueueLayerCorrections = (layerY, options = {}) => {
            const { enqueue = true } = options;
            const expectedActions = expectedActionsByLayer.get(layerY) || [];
            let mismatches = 0;
            let enqueued = 0;
            let alreadyQueued = 0;

            for (const expectedAction of expectedActions) {
                if (isExpectedBlockAt(expectedAction)) continue;

                mismatches++;

                if (!enqueue) {
                    continue;
                }

                if (isActionAlreadyQueued(expectedAction)) {
                    alreadyQueued++;
                    continue;
                }

                build.actions.push({
                    type: 'place',
                    pos: new Vec3(expectedAction.pos.x, expectedAction.pos.y, expectedAction.pos.z),
                    state: expectedAction.state,
                    blockId: expectedAction.blockId,
                    blockName: expectedAction.blockName,
                    metadata: expectedAction.metadata,
                    blockProperties: expectedAction.blockProperties
                });
                enqueued++;
            }

            return { mismatches, enqueued, alreadyQueued };
        };

        // `equipBestToolForBlock` is defined earlier (hoisted) to ensure the
        // correct harvesting tool is equipped before any dig operations.

        const MAX_SAFE_AIR_DROP = 5;

        const hasSolidSupport = (block) => !!(block && block.name !== 'air' && block.boundingBox !== 'empty');

        const isBotOnTargetColumn = (targetPos) => {
            if (!bot.entity || !bot.entity.position) return false;
            const feet = bot.entity.position.floored();
            if (feet.x !== targetPos.x || feet.z !== targetPos.z) return false;
            return feet.y === targetPos.y || feet.y === (targetPos.y + 1);
        };

        const isUnsafeStandingForTarget = (targetPos) => {
            if (!isBotOnTargetColumn(targetPos)) return false;
            const belowTarget = bot.blockAt(targetPos.offset(0, -1, 0), false);
            return isAirLike(belowTarget);
        };

        const canStandAt = (standPos) => {
            const standBlock = bot.blockAt(standPos, false);
            const headBlock = bot.blockAt(standPos.offset(0, 1, 0), false);
            const belowBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
            const standClear = isAirLike(standBlock);
            const headClear = isAirLike(headBlock);
            const hasSupport = hasSolidSupport(belowBlock);
            if (!standClear || !headClear) return false;
            return standClear && hasSupport;
        };

        const getCurrentFeetPos = () => {
            if (!bot.entity || !bot.entity.position) return null;
            const feet = bot.entity.position.floored();
            return new Vec3(feet.x, feet.y, feet.z);
        };

        const canDigFromCurrentPosition = (targetPos) => {
            const feetPos = getCurrentFeetPos();
            if (!feetPos) return false;
            if (isUnsafeStandingForTarget(targetPos)) return false;
            if (!canStandAt(feetPos)) return false;
            return feetPos.distanceTo(targetPos) <= 4.5;
        };

        const getRelocationCandidates = (targetPos) => {
            const ring1 = [
                new Vec3(1, 0, 0),
                new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1),
                new Vec3(0, 0, -1),
                new Vec3(1, 0, 1),
                new Vec3(1, 0, -1),
                new Vec3(-1, 0, 1),
                new Vec3(-1, 0, -1)
            ];

            const ring2 = [
                new Vec3(2, 0, 0),
                new Vec3(-2, 0, 0),
                new Vec3(0, 0, 2),
                new Vec3(0, 0, -2)
            ];

            return [...ring1, ...ring2].map((off) => targetPos.plus(off));
        };

        const getSafeBreakCandidates = (targetPos) => {
            const feetPos = getCurrentFeetPos();
            const yCandidates = Array.from(new Set([
                feetPos ? feetPos.y : targetPos.y,
                targetPos.y,
                targetPos.y + 1
            ]));

            const candidates = [];
            for (const y of yCandidates) {
                for (const basePos of getRelocationCandidates(targetPos)) {
                    const standPos = new Vec3(basePos.x, y, basePos.z);
                    if (!canStandAt(standPos)) continue;
                    if (standPos.distanceTo(targetPos) > 4.5) continue;

                    const supportBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
                    const supportIsScaffold = !!(supportBlock && isScaffoldingMaterial(supportBlock.name));
                    candidates.push({
                        standPos,
                        supportIsScaffold,
                        distToFeet: feetPos ? standPos.distanceSquared(feetPos) : 0
                    });
                }
            }

            candidates.sort((a, b) => {
                if (a.supportIsScaffold !== b.supportIsScaffold) return a.supportIsScaffold ? 1 : -1;
                return a.distToFeet - b.distToFeet;
            });

            return candidates.map((c) => c.standPos);
        };

        const countAirBelow = (startPos, maxDepth = MAX_SAFE_AIR_DROP + 1) => {
            let airCount = 0;
            for (let i = 0; i < maxDepth; i++) {
                const block = bot.blockAt(startPos.offset(0, -i, 0), false);
                if (!isAirLike(block)) break;
                airCount++;
            }
            return airCount;
        };

        const canBreakUnderSelfWithLimitedDrop = (targetPos) => {
            if (!isUnsafeStandingForTarget(targetPos)) return true;
            const airDrop = countAirBelow(targetPos.offset(0, -1, 0), MAX_SAFE_AIR_DROP + 1);
            return airDrop <= MAX_SAFE_AIR_DROP;
        };

        const isBarrierBlock = (block) => {
            if (!block || !block.name) return false;
            return String(block.name).toLowerCase().includes('barrier');
        };

        const isSolidNonScaffoldSupport = (block) => {
            if (!hasSolidSupport(block)) return false;
            if (isScaffoldingMaterial(block.name)) return false;
            if (isBarrierBlock(block)) return false;
            return true;
        };

        const findNearbySolidAnchor = (targetPos) => {
            const feetPos = getCurrentFeetPos();
            if (!feetPos) return null;

            const supportLayerRules = [
                { supportY: targetPos.y, maxDistance: 4 },
                { supportY: targetPos.y + 1, maxDistance: 3 }
            ];

            for (const rule of supportLayerRules) {
                const standY = rule.supportY + 1;
                const candidates = [];

                for (let dx = -rule.maxDistance; dx <= rule.maxDistance; dx++) {
                    for (let dz = -rule.maxDistance; dz <= rule.maxDistance; dz++) {
                        const horizontalDistance = Math.sqrt((dx * dx) + (dz * dz));
                        if (horizontalDistance > rule.maxDistance) continue;

                        const standPos = new Vec3(targetPos.x + dx, standY, targetPos.z + dz);
                        if (!canStandAt(standPos)) continue;

                        const extraHeadroom = bot.blockAt(standPos.offset(0, 2, 0), false);
                        if (!isAirLike(extraHeadroom)) continue;

                        const supportBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
                        if (!isSolidNonScaffoldSupport(supportBlock)) continue;

                        candidates.push({
                            standPos,
                            distToFeet: standPos.distanceSquared(feetPos)
                        });
                    }
                }

                if (candidates.length > 0) {
                    candidates.sort((a, b) => a.distToFeet - b.distToFeet);
                    return candidates[0].standPos;
                }
            }

            return null;
        };

        const getPlacementReference = (placePos) => {
            const directions = getPossibleDirections(placePos);
            if (!directions || directions.length === 0) return null;
            return { block: directions[0].block, face: directions[0].face };
        };

        const getScaffoldInventoryItem = () => {
            const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
            const scaffoldItems = items.filter((item) => item && isScaffoldingMaterial(item.name));
            if (scaffoldItems.length === 0) return null;

            const dirt = scaffoldItems.find((item) => String(item.name || '').toLowerCase().includes('dirt'));
            if (dirt) return dirt;

            const cobble = scaffoldItems.find((item) => String(item.name || '').toLowerCase().includes('cobble'));
            if (cobble) return cobble;

            return scaffoldItems[0] || null;
        };

        const gotoNearWithoutScaffold = async (pos, range = 1) => {
            return gotoNear(pos, range, { forbidPathScaffolding: true });
        };

        const attemptOneBlockBridgeForTarget = async (targetPos, trackScaffold) => {
            const feetPos = getCurrentFeetPos();
            if (!feetPos) return false;

            const offsets = [
                new Vec3(1, 0, 0),
                new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1),
                new Vec3(0, 0, -1)
            ];

            for (const off of offsets) {
                const standPos = feetPos.plus(off);
                if (standPos.distanceTo(targetPos) > 4.5) continue;

                const placePos = standPos.offset(0, -1, 0);
                const existing = bot.blockAt(placePos, false);
                if (!isAirLike(existing)) continue;

                const placement = getPlacementReference(placePos);
                if (!placement) continue;

                try {
                    const item = getScaffoldInventoryItem();
                    if (!item) continue;

                    await bot.equip(item, 'hand');

                    const heldName = bot.heldItem && bot.heldItem.name ? bot.heldItem.name : '';
                    if (!isScaffoldingMaterial(heldName)) {
                        continue;
                    }
                } catch (e) {
                    continue;
                }

                try {
                    await bot.placeBlock(placement.block, placement.face);
                    await wait(50);
                } catch (e) {
                    continue;
                }

                const placed = bot.blockAt(placePos, false);
                if (!hasSolidSupport(placed)) continue;

                if (!isScaffoldingMaterial(placed.name)) {
                    try {
                        if (placed.diggable) {
                                    try { await equipBestToolForBlock(placed); } catch (e) {}
                                    await bot.dig(placed, true);
                                    await wait(50);
                                }
                    } catch (e) {}
                    continue;
                }

                if (isScaffoldingMaterial(placed.name) && typeof trackScaffold === 'function') {
                    trackScaffold(placePos);
                }

                try {
                    await gotoNearWithoutScaffold(standPos, 0);
                } catch (e) {
                    try { await gotoNearWithoutScaffold(standPos, 1); } catch (e2) {}
                }

                if (!isUnsafeStandingForTarget(targetPos)) {
                    return true;
                }
            }

            return false;
        };

        const ensureSafeDigAnchor = async (targetPos, trackScaffold) => {
            if (canDigFromCurrentPosition(targetPos)) return true;

            const candidates = getSafeBreakCandidates(targetPos);

            for (const candidate of candidates) {
                try {
                    await gotoNearWithoutScaffold(candidate, 0);
                } catch (e) {
                    try { await gotoNearWithoutScaffold(candidate, 1); } catch (e2) {}
                }

                if (canDigFromCurrentPosition(targetPos)) {
                    return true;
                }
            }

            if (canBreakUnderSelfWithLimitedDrop(targetPos)) {
                return true;
            }

            const nearbySolidAnchor = findNearbySolidAnchor(targetPos);
            if (nearbySolidAnchor) {
                try {
                    await gotoNearWithoutScaffold(nearbySolidAnchor, 0);
                } catch (e) {
                    try { await gotoNearWithoutScaffold(nearbySolidAnchor, 1); } catch (e2) {}
                }

                if (canDigFromCurrentPosition(targetPos)) {
                    return true;
                }
            }

            const bridged = await attemptOneBlockBridgeForTarget(targetPos, trackScaffold);
            if (bridged && canDigFromCurrentPosition(targetPos)) {
                return true;
            }

            return canDigFromCurrentPosition(targetPos);
        };

        const cleanupPathfinderAroundLayer = async (layerY, reason = 'layer-ended') => {
            const candidateLayers = getLayerRange(layerY, PATHFINDER_CLEANUP_LAYER_RANGE)
                .filter((y) => pathfinderPlacedByLayer.has(y));

            if (candidateLayers.length === 0) return;

            let broken = 0;
            let skippedMissing = 0;
            let skippedExpected = 0;
            let failed = 0;
            const MAX_SAFE_AIR_DROP = 5;

            const getTrackedScaffoldKeys = () => {
                const keys = new Set();
                for (const trackedLayer of candidateLayers) {
                    const layerSet = pathfinderPlacedByLayer.get(trackedLayer);
                    if (!layerSet || layerSet.size === 0) continue;
                    for (const key of layerSet) keys.add(key);
                }
                return keys;
            };

            const isAirLike = (block) => !block || block.name === 'air' || block.boundingBox === 'empty';

            const hasSolidSupport = (block) => !!(block && block.name !== 'air' && block.boundingBox !== 'empty');

            const isBotOnTargetColumn = (targetPos) => {
                if (!bot.entity || !bot.entity.position) return false;
                const feet = bot.entity.position.floored();
                if (feet.x !== targetPos.x || feet.z !== targetPos.z) return false;
                return feet.y === targetPos.y || feet.y === (targetPos.y + 1);
            };

            const isUnsafeStandingForTarget = (targetPos) => {
                if (!isBotOnTargetColumn(targetPos)) return false;
                const belowTarget = bot.blockAt(targetPos.offset(0, -1, 0), false);
                return isAirLike(belowTarget);
            };

            const canStandAt = (standPos) => {
                const standBlock = bot.blockAt(standPos, false);
                const headBlock = bot.blockAt(standPos.offset(0, 1, 0), false);
                const belowBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
                const standClear = isAirLike(standBlock);
                const headClear = isAirLike(headBlock);
                const hasSupport = hasSolidSupport(belowBlock);
                if (!standClear || !headClear) return false;
                return standClear && hasSupport;
            };

            const getCurrentFeetPos = () => {
                if (!bot.entity || !bot.entity.position) return null;
                const feet = bot.entity.position.floored();
                return new Vec3(feet.x, feet.y, feet.z);
            };

            const canDigFromCurrentPosition = (targetPos, trackedKeys) => {
                const feetPos = getCurrentFeetPos();
                if (!feetPos) return false;
                if (isUnsafeStandingForTarget(targetPos)) return false;
                if (!canStandAt(feetPos)) return false;
                return feetPos.distanceTo(targetPos) <= 4.5;
            };

            const getRelocationCandidates = (targetPos) => {
                const ring1 = [
                    new Vec3(1, 0, 0),
                    new Vec3(-1, 0, 0),
                    new Vec3(0, 0, 1),
                    new Vec3(0, 0, -1),
                    new Vec3(1, 0, 1),
                    new Vec3(1, 0, -1),
                    new Vec3(-1, 0, 1),
                    new Vec3(-1, 0, -1)
                ];

                const ring2 = [
                    new Vec3(2, 0, 0),
                    new Vec3(-2, 0, 0),
                    new Vec3(0, 0, 2),
                    new Vec3(0, 0, -2)
                ];

                return [...ring1, ...ring2].map((off) => targetPos.plus(off));
            };

            const getSafeBreakCandidates = (targetPos) => {
                const feetPos = getCurrentFeetPos();
                const yCandidates = Array.from(new Set([
                    feetPos ? feetPos.y : targetPos.y,
                    targetPos.y,
                    targetPos.y + 1
                ]));

                const candidates = [];
                for (const y of yCandidates) {
                    for (const basePos of getRelocationCandidates(targetPos)) {
                        const standPos = new Vec3(basePos.x, y, basePos.z);
                        if (!canStandAt(standPos)) continue;
                        if (standPos.distanceTo(targetPos) > 4.5) continue;

                        const supportBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
                        const supportIsScaffold = !!(supportBlock && isScaffoldingMaterial(supportBlock.name));
                        candidates.push({
                            standPos,
                            supportIsScaffold,
                            distToFeet: feetPos ? standPos.distanceSquared(feetPos) : 0
                        });
                    }
                }

                candidates.sort((a, b) => {
                    // Prefer non-scaffold support first, scaffold support as fallback.
                    if (a.supportIsScaffold !== b.supportIsScaffold) return a.supportIsScaffold ? 1 : -1;
                    return a.distToFeet - b.distToFeet;
                });

                return candidates.map((c) => c.standPos);
            };

            const countAirBelow = (startPos, maxDepth = MAX_SAFE_AIR_DROP + 1) => {
                let airCount = 0;
                for (let i = 0; i < maxDepth; i++) {
                    const block = bot.blockAt(startPos.offset(0, -i, 0), false);
                    if (!isAirLike(block)) break;
                    airCount++;
                }
                return airCount;
            };

            const canBreakUnderSelfWithLimitedDrop = (targetPos) => {
                if (!isUnsafeStandingForTarget(targetPos)) return true;
                const airDrop = countAirBelow(targetPos.offset(0, -1, 0), MAX_SAFE_AIR_DROP + 1);
                return airDrop <= MAX_SAFE_AIR_DROP;
            };

            const isBarrierBlock = (block) => {
                if (!block || !block.name) return false;
                return String(block.name).toLowerCase().includes('barrier');
            };

            const isSolidNonScaffoldSupport = (block) => {
                if (!hasSolidSupport(block)) return false;
                if (isScaffoldingMaterial(block.name)) return false;
                if (isBarrierBlock(block)) return false;
                return true;
            };

            const findNearbySolidAnchor = (targetPos) => {
                const feetPos = getCurrentFeetPos();
                if (!feetPos) return null;

                const supportLayerRules = [
                    { supportY: targetPos.y, maxDistance: 4 },
                    { supportY: targetPos.y + 1, maxDistance: 3 }
                ];

                for (const rule of supportLayerRules) {
                    const standY = rule.supportY + 1;
                    const candidates = [];

                    for (let dx = -rule.maxDistance; dx <= rule.maxDistance; dx++) {
                        for (let dz = -rule.maxDistance; dz <= rule.maxDistance; dz++) {
                            const horizontalDistance = Math.sqrt((dx * dx) + (dz * dz));
                            if (horizontalDistance > rule.maxDistance) continue;

                            const standPos = new Vec3(targetPos.x + dx, standY, targetPos.z + dz);
                            if (!canStandAt(standPos)) continue;

                            // Require one extra headroom block (feet/head + one more) for safer anchor spots.
                            const extraHeadroom = bot.blockAt(standPos.offset(0, 2, 0), false);
                            if (!isAirLike(extraHeadroom)) continue;

                            const supportBlock = bot.blockAt(standPos.offset(0, -1, 0), false);
                            if (!isSolidNonScaffoldSupport(supportBlock)) continue;

                            candidates.push({
                                standPos,
                                distToFeet: standPos.distanceSquared(feetPos)
                            });
                        }
                    }

                    if (candidates.length > 0) {
                        candidates.sort((a, b) => a.distToFeet - b.distToFeet);
                        return candidates[0].standPos;
                    }
                }

                return null;
            };

            const getPlacementReference = (placePos) => {
                const directions = getPossibleDirections(placePos);
                if (!directions || directions.length === 0) return null;
                return { block: directions[0].block, face: directions[0].face };
            };

            const getScaffoldInventoryItem = () => {
                const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
                const scaffoldItems = items.filter((item) => item && isScaffoldingMaterial(item.name));
                if (scaffoldItems.length === 0) return null;

                // Prefer dirt first, then cobble family.
                const dirt = scaffoldItems.find((item) => String(item.name || '').toLowerCase().includes('dirt'));
                if (dirt) return dirt;

                const cobble = scaffoldItems.find((item) => String(item.name || '').toLowerCase().includes('cobble'));
                if (cobble) return cobble;

                return scaffoldItems[0] || null;
            };

            const trackBridgeScaffold = (placePos) => {
                const layer = placePos.y;
                if (!pathfinderPlacedByLayer.has(layer)) {
                    pathfinderPlacedByLayer.set(layer, new Set());
                }
                pathfinderPlacedByLayer.get(layer).add(posToKey(placePos));
            };

            const attemptOneBlockBridgeForTarget = async (targetPos) => {
                const feetPos = getCurrentFeetPos();
                if (!feetPos) return false;

                const offsets = [
                    new Vec3(1, 0, 0),
                    new Vec3(-1, 0, 0),
                    new Vec3(0, 0, 1),
                    new Vec3(0, 0, -1)
                ];

                for (const off of offsets) {
                    const standPos = feetPos.plus(off);
                    if (standPos.distanceTo(targetPos) > 4.5) continue;

                    const placePos = standPos.offset(0, -1, 0);
                    const existing = bot.blockAt(placePos, false);
                    if (!isAirLike(existing)) continue;

                    const placement = getPlacementReference(placePos);
                    if (!placement) continue;

                    try {
                        const item = getScaffoldInventoryItem();
                        if (!item) continue;

                        await bot.equip(item, 'hand');

                        const heldName = bot.heldItem && bot.heldItem.name ? bot.heldItem.name : '';
                        if (!isScaffoldingMaterial(heldName)) {
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }

                    try {
                        await bot.placeBlock(placement.block, placement.face);
                        await wait(50);
                    } catch (e) {
                        continue;
                    }

                    const placed = bot.blockAt(placePos, false);
                    if (!hasSolidSupport(placed)) continue;

                    if (!isScaffoldingMaterial(placed.name)) {
                        try {
                            if (placed.diggable) {
                                        try { await equipBestToolForBlock(placed); } catch (e) {}
                                        await bot.dig(placed, true);
                                        await wait(50);
                                    }
                        } catch (e) {}
                        continue;
                    }

                    if (isScaffoldingMaterial(placed.name)) {
                        trackBridgeScaffold(placePos);
                    }

                    try {
                        await gotoNearWithoutScaffold(standPos, 0);
                    } catch (e) {
                        try { await gotoNearWithoutScaffold(standPos, 1); } catch (e2) {}
                    }

                    if (!isUnsafeStandingForTarget(targetPos)) {
                        return true;
                    }
                }

                return false;
            };

            const gotoNearWithoutScaffold = async (pos, range = 1) => {
                return gotoNear(pos, range, { forbidPathScaffolding: true });
            };

            const ensureSafeDigAnchor = async (targetPos, trackedKeys) => {
                if (canDigFromCurrentPosition(targetPos, trackedKeys)) return true;

                const candidates = getSafeBreakCandidates(targetPos);

                for (const candidate of candidates) {
                    try {
                        await gotoNearWithoutScaffold(candidate, 0);
                    } catch (e) {
                        try { await gotoNearWithoutScaffold(candidate, 1); } catch (e2) {}
                    }

                    if (canDigFromCurrentPosition(targetPos, trackedKeys)) {
                        return true;
                    }
                }

                // No stand spot found: allow direct break under self only when drop <= 5 blocks of air.
                if (canBreakUnderSelfWithLimitedDrop(targetPos)) {
                    return true;
                }

                // Before bridging, try nearby solid non-scaffold anchors:
                // support at y => <= 4 blocks, support at y+1 => <= 3 blocks.
                const nearbySolidAnchor = findNearbySolidAnchor(targetPos);
                if (nearbySolidAnchor) {
                    try {
                        await gotoNearWithoutScaffold(nearbySolidAnchor, 0);
                    } catch (e) {
                        try { await gotoNearWithoutScaffold(nearbySolidAnchor, 1); } catch (e2) {}
                    }

                    if (canDigFromCurrentPosition(targetPos, trackedKeys)) {
                        return true;
                    }
                }

                // If drop is unsafe, bridge one adjacent block then step on it.
                const bridged = await attemptOneBlockBridgeForTarget(targetPos);
                if (bridged && canDigFromCurrentPosition(targetPos, trackedKeys)) {
                    return true;
                }

                return canDigFromCurrentPosition(targetPos, trackedKeys);
            };

            for (const trackedLayer of candidateLayers) {
                const layerSet = pathfinderPlacedByLayer.get(trackedLayer);
                if (!layerSet || layerSet.size === 0) {
                    pathfinderPlacedByLayer.delete(trackedLayer);
                    continue;
                }

                for (const key of Array.from(layerSet)) {
                    if (!bot.builder || !bot.builder.isBuilding) break;

                    const pos = keyToPos(key);
                    const blockAtPos = bot.blockAt(pos, false);
                    if (!blockAtPos || blockAtPos.name === 'air' || !blockAtPos.diggable) {
                        skippedMissing++;
                        layerSet.delete(key);
                        continue;
                    }

                    const expectedAction = desiredActionByPos.get(posKey(pos));
                    if (expectedAction && normalizeStr(expectedAction.blockName) === normalizeStr(blockAtPos.name)) {
                        skippedExpected++;
                        layerSet.delete(key);
                        continue;
                    }

                    try {
                        const trackedKeys = getTrackedScaffoldKeys();
                        const safeAnchorReady = await ensureSafeDigAnchor(pos, trackedKeys);
                        if (!safeAnchorReady) {
                            failed++;
                            continue;
                        }

                        await equipBestToolForBlock(blockAtPos);
                        bot.setControlState('sneak', true);
                        await bot.dig(blockAtPos, true);
                        bot.setControlState('sneak', false);
                        broken++;
                        layerSet.delete(key);
                    } catch (e) {
                        try { bot.setControlState('sneak', false); } catch (e2) {}
                        failed++;
                    }
                }

                if (layerSet.size === 0) {
                    pathfinderPlacedByLayer.delete(trackedLayer);
                }
            }

            console.log(`[build-layer-pathfinder-cleanup] centerLayer=${layerY} reason=${reason} range=${PATHFINDER_CLEANUP_LAYER_RANGE} broken=${broken} skippedMissing=${skippedMissing} skippedExpected=${skippedExpected} failed=${failed}`);
        };

        const cleanupResidualPathfinderBlocks = async (reason = 'build-ended') => {
            const remainingLayers = Array.from(pathfinderPlacedByLayer.keys()).sort((a, b) => a - b);
            for (const layerY of remainingLayers) {
                await cleanupPathfinderAroundLayer(layerY, reason);
            }
        };

        try {
            if (settings.clearArea) {
                await bot.builder.clearArea(build);
            }
            
            console.log(`🏗️  Starting build of ${build.actions.length} blocks...`);
            console.log(`⚡ Speed: ${settings.buildSpeed} blocks/second`);

            // Refill initial : précharger les blocs des premières couches depuis les coffres
            // AVANT de commencer à poser. Évite le démarrage "bloc par bloc" (le bot posait
            // d'abord son inventaire sans preshot, puis ne faisait le preshot qu'au premier
            // bloc manquant).
            try {
                const isCreativeInit = !!(bot && bot.game && String(bot.game.gameMode || '').toLowerCase() === 'creative');
                if (!isCreativeInit) {
                    const initialLayerY = build.min.y;
                    const initialPrefetchLayers = Math.max(0, Number(settings.prefetchLayers || 0));
                    const initialLayerMax = Math.min(
                        build.max.y - 1,
                        initialLayerY + initialPrefetchLayers
                    );
                    const initialLayerActions = (build.actions || []).filter(
                        (a) => a && a.type === 'place' && a.pos && a.pos.y >= initialLayerY && a.pos.y <= initialLayerMax
                    );
                    if (initialLayerActions.length > 0 && typeof batchRefillForLayer === 'function') {
                        console.log(`[build] Initial refill for layers ${initialLayerY}..${initialLayerMax} (${initialLayerActions.length} actions)...`);
                        const initialRefill = await batchRefillForLayer(initialLayerActions, build);
                        if (initialRefill && initialRefill.taken > 0) {
                            console.log(`[build] Initial refill complete. Taken=${initialRefill.taken}`);
                        }
                    }
                }
            } catch (e) {
                console.warn('[build] Initial refill failed:', e && e.message ? e.message : e);
            }
            
            let consecutiveFailures = 0;
            const maxConsecutiveFailures = 10;
            let lastPlacedNameKey = null; // Pour tracker le dernier type de bloc placé

            const emitLayerFinished = (layerY, reason = 'depleted') => {
                try {
                    const remainingOnLayer = (build.actions || []).filter((a) => a && a.type === 'place' && a.pos && a.pos.y === layerY).length;
                    bot.emit('builder_layer_finished', {
                        layerY,
                        reason,
                        remainingOnLayer,
                        totalRemaining: (build.actions || []).length
                    });
                } catch (e) {}
            };

            // Build layer-by-layer (y axis) from bottom to top
            let currentLayer = build.min.y;
            const topLayer = build.max.y - 1;
            let layerWaitCounter = 0;
            const layerCorrectionDone = new Set();

            const logActionFailure = (action, reason, error = null) => {
                const pos = action && action.pos ? action.pos : null;
                const posText = pos ? `(${pos.x},${pos.y},${pos.z})` : '(unknown)';
                const blockName = action && action.blockName ? action.blockName : 'unknown';
                const retryCount = action && action.retryCount ? action.retryCount : 0;
                const orientationRetries = action && action.orientationRetries ? action.orientationRetries : 0;
                const errMsg = error && error.message ? error.message : (error ? String(error) : 'none');

                console.warn(
                    `[build-action-failed] reason=${reason} block=${blockName} pos=${posText} retry=${retryCount} orientationRetry=${orientationRetries} err=${errMsg}`
                );
            };

            const refillWindowLayers = Math.max(0, Number.isFinite(Number(settings.prefetchLayers)) ? Number(settings.prefetchLayers) : 3);
            const refillReserveSlots = Math.max(0, Number(settings.reserveInventorySlots || 5));
            const refillCooldownMs = 5000;
            const maxRefillAttemptsPerLayer = 3;
            let lastRefillAt = 0;
            let lastRefillLayer = null;
            const refillAttemptsByLayer = new Map();

            const getInvCountByName = () => {
                const invCount = {};
                try {
                    const invItems = bot.inventory.items() || [];
                    for (const it of invItems) {
                        if (!it) continue;
                        const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                        if (!iname) continue;
                        const key = String(iname).toLowerCase();
                        invCount[key] = (invCount[key] || 0) + (it.count || 0);
                    }
                } catch (e) {}
                return invCount;
            };

            const computeNeedMapForWindow = (layerMin, layerMax) => {
                const needMap = {};
                const actionsSnapshot = Array.isArray(build.actions) ? build.actions.slice() : [];
                for (const act of actionsSnapshot) {
                    if (!act || act.type !== 'place' || !act.pos) continue;
                    if (act.pos.y < layerMin || act.pos.y > layerMax) continue;
                    let item = null;
                    try { item = build.getItemForState(act.state); } catch (e) { item = null; }
                    const nameKey = (item && item.name) ? String(item.name).toLowerCase() : String(act.blockName || '').toLowerCase();
                    if (!nameKey) continue;
                    needMap[nameKey] = (needMap[nameKey] || 0) + 1;
                }
                return needMap;
            };

            const planRefill = (needMap, invCount, currentLayerNeedMap = {}) => {
                const invItems = bot.inventory.items() || [];
                const maxSlots = 36 - refillReserveSlots;
                let freeSlots = Math.max(0, maxSlots - invItems.length);

                let entries = Object.entries(needMap)
                    .map(([nameKey, totalNeeded]) => {
                        const have = invCount[nameKey] || 0;
                        const missing = Math.max(0, totalNeeded - have);
                        const currentNeed = currentLayerNeedMap[nameKey] || 0;
                        const currentMissing = Math.max(0, currentNeed - have);
                        return { nameKey, totalNeeded, have, missing, currentNeed, currentMissing };
                    })
                    .filter(entry => entry.missing > 0)
                    .sort((a, b) => {
                        const aCur = a.currentMissing > 0;
                        const bCur = b.currentMissing > 0;
                        if (aCur !== bCur) return aCur ? -1 : 1;
                        if (a.currentMissing !== b.currentMissing) return b.currentMissing - a.currentMissing;
                        return b.missing - a.missing;
                    });

                if (entries.some(entry => entry.currentMissing > 0)) {
                    entries = entries.filter(entry => entry.currentMissing > 0);
                }

                const plan = [];
                for (const entry of entries) {
                    const { nameKey, missing, have } = entry;
                    const mcItem = (mcData && mcData.itemsByName) ? mcData.itemsByName[nameKey] : null;
                    const maxStack = (mcItem && mcItem.stackSize) ? mcItem.stackSize : 64;
                    const ident = (mcItem && mcItem.id) ? mcItem.id : nameKey;

                    const freeInExisting = have > 0 ? (maxStack - (have % maxStack || maxStack)) : 0;
                    let want = 0;

                    if (freeInExisting > 0) {
                        want += Math.min(missing, freeInExisting);
                    }

                    const remainingMissing = Math.max(0, missing - want);
                    if (remainingMissing > 0 && freeSlots > 0) {
                        const neededStacks = Math.ceil(remainingMissing / maxStack);
                        const stacksToTake = Math.min(neededStacks, freeSlots);
                        want += stacksToTake * maxStack;
                        freeSlots = Math.max(0, freeSlots - stacksToTake);
                    }

                    if (want > 0) {
                        plan.push({ nameKey, ident, want: Math.min(missing, want), missing, maxStack });
                    }
                }

                return plan;
            };

            const refillFromLinkedChests = async (plan) => {
                const linked = (typeof bot.builder.getLinkedChests === 'function')
                    ? bot.builder.getLinkedChests()
                    : (Array.isArray(bot.builder._linkedBuildChests) ? bot.builder._linkedBuildChests.slice() : []);
                if (!Array.isArray(linked) || linked.length === 0) return { taken: 0 };

                const remaining = {};
                for (const entry of plan) remaining[entry.nameKey] = entry.want;

                const botPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
                linked.sort((a, b) => {
                    const pa = (a && typeof a.x === 'number') ? new Vec3(a.x, a.y, a.z) : a;
                    const pb = (b && typeof b.x === 'number') ? new Vec3(b.x, b.y, b.z) : b;
                    if (!botPos || !pa || !pb) return 0;
                    return botPos.distanceTo(pa) - botPos.distanceTo(pb);
                });

                let totalTaken = 0;
                for (const chestEntry of linked) {
                    if (Object.values(remaining).every(v => v <= 0)) break;
                    if (!chestEntry) continue;
                    const chestPos = (typeof chestEntry.x === 'number' && typeof chestEntry.y === 'number' && typeof chestEntry.z === 'number')
                        ? new Vec3(chestEntry.x, chestEntry.y, chestEntry.z)
                        : (chestEntry instanceof Vec3 ? chestEntry : null);
                    if (!chestPos) continue;

                    try {
                        const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                        if (distance > 4.5) {
                            try { await gotoNear(chestPos, 3); } catch (e) {}
                        }
                    } catch (e) {}

                    const refillResult = await runChestTransaction(chestPos, async (chest) => {
                        let takenHere = 0;
                        const slots = (typeof chest.containerItems === 'function')
                            ? chest.containerItems()
                            : (chest && chest.container && Array.isArray(chest.container.slots) ? chest.container.slots : []);
                        for (const s of (slots || [])) {
                            if (!s || !s.name) continue;
                            const sname = String(s.name || s.displayName || '').toLowerCase().replace(/^minecraft:/, '');
                            const want = remaining[sname] || 0;
                            if (want <= 0) continue;
                            const take = Math.min(want, s.count || 0);
                            if (take <= 0) continue;
                            try {
                                if (typeof chest.withdraw === 'function') {
                                    await chest.withdraw(s.type || s.id, null, take);
                                    takenHere += take;
                                    remaining[sname] = Math.max(0, remaining[sname] - take);
                                    await wait(80);
                                }
                            } catch (e) {}
                        }
                        return takenHere;
                    });

                    if (refillResult && refillResult.ok) {
                        totalTaken += Number(refillResult.result || 0);
                    }
                }

                return { taken: totalTaken };
            };

            while (build.actions.length > 0 && currentLayer <= topLayer) {
                if (build.isCancelled) {
                    bot.emit('builder_cancelled');
                    break;
                }

                if (build.isPaused) {
                    await wait(1000);
                    continue;
                }

                // Only consider actions on the current layer
                const actionsOnLayer = build.actions.filter(a => a.pos.y === currentLayer);

                // Prefetch items from linked chests for current + upcoming layers (survival only).
                try {
                    if (prefetchEnabled && actionsOnLayer.length > 0 && bot.builder) {
                        // control whether we should skip prefetch because a previous batch is still
                        // available (we only re-prefetch when previously fetched items are consumed)
                        let skipPrefetchForLayer = false;
                        try {
                            const invItems = bot.inventory.items() || [];
                            const invCountByName = {};
                            for (const it of invItems) {
                                if (!it) continue;
                                const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                                if (!iname) continue;
                                const key = String(iname).toLowerCase();
                                invCountByName[key] = (invCountByName[key] || 0) + (it.count || 0);
                            }

                            let needsRefill = false;
                            const layerKeys = new Set();
                            for (const act of actionsOnLayer) {
                                if (!act || act.type !== 'place') continue;
                                let item = null;
                                try { item = build.getItemForState(act.state); } catch (e) { item = null; }
                                const nameKey = (item && item.name) ? String(item.name).toLowerCase() : String(act.blockName || '').toLowerCase();
                                if (nameKey) layerKeys.add(nameKey);
                            }

                            for (const key of layerKeys) {
                                if (!invCountByName[key] || invCountByName[key] <= 0) {
                                    needsRefill = true;
                                    break;
                                }
                            }

                            if (!needsRefill) {
                                skipPrefetchForLayer = true;
                            }
                        } catch (e) {}
                        const _prefetchLayersTemp = Number(settings.prefetchLayers || 0);
                        if (_prefetchLayersTemp > 0 && activePrefetch) {
                            try {
                                const invNow = bot.inventory.items() || [];
                                let anyLeft = false;
                                for (const k of (activePrefetch.keys || [])) {
                                    const have = (invNow || []).reduce((s, it) => {
                                        if (!it) return s;
                                        const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                                        if (!iname) return s;
                                        return s + ((String(iname).toLowerCase() === k) ? (it.count || 0) : 0);
                                    }, 0);
                                    if (have > 0) { anyLeft = true; break; }
                                }
                                if (anyLeft) {
                                    skipPrefetchForLayer = true;
                                } else {
                                    activePrefetch = null;
                                }
                            } catch (e) {}
                        }

                        if (pendingPrefetch && pendingPrefetch.remaining && Object.keys(pendingPrefetch.remaining).length > 0) {
                            skipPrefetchForLayer = false;
                        }

                        if (!skipPrefetchForLayer) {
                        const linked = (typeof bot.builder.getLinkedChests === 'function') ? bot.builder.getLinkedChests() : (Array.isArray(bot.builder._linkedBuildChests) ? bot.builder._linkedBuildChests.slice() : []);
                        if (Array.isArray(linked) && linked.length > 0 && String(bot.game && bot.game.gameMode || '').toLowerCase() !== 'creative') {
                            const prefetchLayers = Number.isFinite(Number(settings.prefetchLayers)) ? Number(settings.prefetchLayers) : 0;
                            const reserveSlots = Number(settings.reserveInventorySlots || 5);
                            if (prefetchLayers > 0) {
                                const layerMax = Math.min(topLayer, currentLayer + prefetchLayers);
                                let needMap = null;
                                if (pendingPrefetch && pendingPrefetch.layerMax >= currentLayer) {
                                    try { await refreshLinkedChestMapping(linked, Object.keys(pendingPrefetch.remaining || {})); } catch (e) {}
                                    needMap = {};
                                    for (const [k, v] of Object.entries(pendingPrefetch.remaining || {})) {
                                        if (!k || !v || !v.need) continue;
                                        needMap[k] = v.need;
                                    }
                                } else {
                                    pendingPrefetch = null;
                                    needMap = {};
                                    const actionsSnapshot = Array.isArray(build.actions) ? build.actions.slice() : [];
                                    for (const act of actionsSnapshot) {
                                        if (!act || act.type !== 'place' || !act.pos) continue;
                                        if (act.pos.y < currentLayer || act.pos.y > layerMax) continue;
                                        let item = null;
                                        try { item = build.getItemForState(act.state); } catch (e) { item = null; }
                                        const nameKey = (item && item.name) ? String(item.name).toLowerCase() : String(act.blockName || '').toLowerCase();
                                        if (!nameKey) continue;
                                        needMap[nameKey] = (needMap[nameKey] || 0) + 1;
                                    }
                                }

                                const invItems = bot.inventory.items();
                                const emptySlots = Math.max(0, 36 - (invItems ? invItems.length : 0));

                                // Build list of prefetch requests (nameKey, ident, toFetch)
                                const prefetchRequests = [];
                                let remainingSpace = Math.max(0, (emptySlots - reserveSlots) * 64);
                                for (const nameKey of Object.keys(needMap)) {
                                    const totalNeeded = needMap[nameKey] || 0;
                                    const mcItem = (mcData && mcData.itemsByName) ? mcData.itemsByName[nameKey] : null;
                                    const maxStack = (mcItem && mcItem.stackSize) ? mcItem.stackSize : 64;

                                    let have = 0;
                                    let partialSpace = 0;
                                    for (const inv of (invItems || [])) {
                                        if (!inv) continue;
                                        const invName = inv.name || ((mcData && mcData.itemsById && mcData.itemsById[inv.type]) ? mcData.itemsById[inv.type].name : null);
                                        if (!invName) continue;
                                        if (String(invName).toLowerCase() === nameKey) {
                                            have += inv.count || 0;
                                            partialSpace += (maxStack - (inv.count || 0));
                                        }
                                    }

                                    const usableEmptySlots = Math.max(0, emptySlots - reserveSlots);
                                    const availableSpace = partialSpace + usableEmptySlots * maxStack;
                                    const need = Math.max(0, totalNeeded - have);
                                    const toFetch = Math.min(need, availableSpace, remainingSpace);

                                    if (toFetch > 0) {
                                        const ident = (mcItem && mcItem.id) ? mcItem.id : nameKey;
                                        prefetchRequests.push({ nameKey, ident, toFetch });
                                        remainingSpace = Math.max(0, remainingSpace - toFetch);
                                    }
                                    if (remainingSpace <= 0) break;
                                }

                                if (prefetchRequests.length > 0) {
                                    const hasChestMapping = Array.isArray(linked) && linked.some(e => e && typeof e === 'object' && e.items && typeof e.items === 'object');

                                    if (hasChestMapping) {
                                        // track which keys we actually fetched this batch (nameKey -> count)
                                        const fetchedThisBatch = {};
                                        // Distribute requests chest-by-chest using the saved mapping
                                        const remaining = {};
                                        for (const r of prefetchRequests) remaining[r.nameKey] = r.toFetch;

                                        for (const chestEntry of linked) {
                                            if (Object.values(remaining).every(v => v <= 0)) break;
                                            if (!chestEntry) continue;
                                            const chestItems = chestEntry.items || null;
                                            if (!chestItems || typeof chestItems !== 'object') continue;

                                            const chestPos = (typeof chestEntry.x === 'number' && typeof chestEntry.y === 'number' && typeof chestEntry.z === 'number')
                                                ? new Vec3(chestEntry.x, chestEntry.y, chestEntry.z)
                                                : chestEntry;

                                            const takeList = [];
                                            for (const r of prefetchRequests) {
                                                const want = remaining[r.nameKey] || 0;
                                                if (want <= 0) continue;
                                                const cinfo = chestItems[r.nameKey];
                                                const chestCount = cinfo ? (typeof cinfo === 'object' ? (cinfo.count || 0) : (Number(cinfo) || 0)) : 0;
                                                if (!chestCount || chestCount <= 0) continue;
                                                const take = Math.min(chestCount, want);
                                                const mcItem = (mcData && mcData.itemsByName) ? mcData.itemsByName[r.nameKey] : null;
                                                const ident = (mcItem && mcItem.id) ? mcItem.id : r.ident;
                                                takeList.push({ ident, nameKey: r.nameKey, count: take });
                                                remaining[r.nameKey] = Math.max(0, remaining[r.nameKey] - take);
                                            }

                                            if (takeList.length === 0) continue;

                                            // Withdraw all requested items from this chest in one open
                                            try {
                                                try {
                                                    const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                                                    if (distance > 4.5) {
                                                        try { await gotoNear(chestPos, 3); } catch (e) {}
                                                    }
                                                } catch (e) {}

                                                // snapshot inventory counts for requested keys
                                                const monitoredKeys = Array.from(new Set(takeList.map(t => t.nameKey)));
                                                const countInv = (nameKey) => {
                                                    try {
                                                        return (bot.inventory.items() || []).reduce((s, it) => {
                                                            if (!it) return s;
                                                            const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                                                            if (!iname) return s;
                                                            return s + ((String(iname).toLowerCase() === nameKey) ? (it.count || 0) : 0);
                                                        }, 0);
                                                    } catch (e) { return 0; }
                                                };

                                                const txnResult = await runChestTransaction(chestPos, async (chest) => {
                                                    const invBeforeMap = {};
                                                    for (const k of monitoredKeys) invBeforeMap[k] = countInv(k);

                                                    for (const t of takeList) {
                                                        if (typeof chest.withdraw === 'function') {
                                                            try { await chest.withdraw(t.ident, null, t.count); } catch (e) {}
                                                            await wait(120);
                                                        } else {
                                                            try {
                                                                const slots = (typeof chest.containerItems === 'function') ? chest.containerItems() : (chest && chest.container && Array.isArray(chest.container.slots) ? chest.container.slots : []);
                                                                for (const s of (slots || [])) {
                                                                    if (!s) continue;
                                                                    const sname = String((s.name || s.displayName || '')).toLowerCase();
                                                                    if (sname === t.nameKey || (s.type && s.type === t.ident)) {
                                                                        const want = t.count;
                                                                        if (typeof chest.withdraw === 'function') {
                                                                            try { await chest.withdraw(s.type || t.ident, null, want); } catch(e) {}
                                                                            await wait(120);
                                                                        }
                                                                        break;
                                                                    }
                                                                }
                                                            } catch(e) {}
                                                        }
                                                    }

                                                    const invAfterMap = {};
                                                    for (const k of monitoredKeys) invAfterMap[k] = countInv(k);
                                                    return { monitoredKeys, invBeforeMap, invAfterMap };
                                                });

                                                if (!txnResult || !txnResult.ok) continue;

                                                // update mapping based on actual inventory change
                                                try {
                                                    const data = txnResult.result || {};
                                                    const invBeforeMap = data.invBeforeMap || {};
                                                    const invAfterMap = data.invAfterMap || {};
                                                    for (const k of monitoredKeys) {
                                                        const delta = Math.max(0, (invAfterMap[k] || 0) - (invBeforeMap[k] || 0));
                                                        if (delta > 0 && chestEntry && chestEntry.items && chestEntry.items[k]) {
                                                            try {
                                                                const existing = chestEntry.items[k];
                                                                if (existing && typeof existing === 'object') {
                                                                    existing.count = Math.max(0, (existing.count || 0) - delta);
                                                                } else {
                                                                    chestEntry.items[k] = Math.max(0, (Number(existing) || 0) - delta);
                                                                }
                                                            } catch (e) {}
                                                        }
                                                    }
                                                } catch (e) {}
                                            } catch (e) {
                                                console.warn('[build] chest-level withdraw failed for', chestPos, e && e.message ? e.message : e);
                                            }
                                        }

                                        // Recompute inventory and attempt a second chest-by-chest pass
                                        // for leftovers to avoid reopening coffers per-item.
                                        let invNow = bot.inventory.items();
                                        const countInInventory = (invArr, nameKey) => {
                                            try {
                                                return (invArr || []).reduce((s, it) => {
                                                    if (!it) return s;
                                                    const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                                                    if (!iname) return s;
                                                    return s + ((String(iname).toLowerCase() === nameKey) ? (it.count || 0) : 0);
                                                }, 0);
                                            } catch (e) { return 0; }
                                        };

                                        const remainingNeeds = {};
                                        for (const r of prefetchRequests) {
                                            const nowHave = countInInventory(invNow, r.nameKey);
                                            const stillNeed = Math.max(0, r.toFetch - nowHave);
                                            if (stillNeed > 0) remainingNeeds[r.nameKey] = { ident: r.ident, need: stillNeed };
                                        }

                                        if (Object.keys(remainingNeeds).length > 0) {
                                            for (const chestEntry of linked) {
                                                if (Object.values(remainingNeeds).every(x => x.need <= 0)) break;
                                                if (!chestEntry) continue;
                                                const chestItems = chestEntry.items || null;
                                                if (!chestItems || typeof chestItems !== 'object') continue;

                                                const chestPos = (typeof chestEntry.x === 'number' && typeof chestEntry.y === 'number' && typeof chestEntry.z === 'number')
                                                    ? new Vec3(chestEntry.x, chestEntry.y, chestEntry.z)
                                                    : chestEntry;

                                                const takeList = [];
                                                for (const nameKey of Object.keys(remainingNeeds)) {
                                                    const want = remainingNeeds[nameKey].need || 0;
                                                    if (want <= 0) continue;
                                                    const cinfo = chestItems[nameKey];
                                                    const chestCount = cinfo ? (typeof cinfo === 'object' ? (cinfo.count || 0) : (Number(cinfo) || 0)) : 0;
                                                    if (!chestCount || chestCount <= 0) continue;
                                                    const take = Math.min(chestCount, want);
                                                    const ident = remainingNeeds[nameKey].ident;
                                                    takeList.push({ ident, nameKey, count: take });
                                                    remainingNeeds[nameKey].need = Math.max(0, remainingNeeds[nameKey].need - take);
                                                }

                                                if (takeList.length === 0) continue;

                                                try {
                                                    try {
                                                        const distance = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(chestPos) : 0;
                                                        if (distance > 4.5) {
                                                            try { await gotoNear(chestPos, 3); } catch (e) {}
                                                        }
                                                    } catch (e) {}

                                                    const monitoredKeys = Array.from(new Set(takeList.map(t => t.nameKey)));
                                                    const countInv = (nameKey) => {
                                                        try {
                                                            return (bot.inventory.items() || []).reduce((s, it) => {
                                                                if (!it) return s;
                                                                const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                                                                if (!iname) return s;
                                                                return s + ((String(iname).toLowerCase() === nameKey) ? (it.count || 0) : 0);
                                                            }, 0);
                                                        } catch (e) { return 0; }
                                                    };

                                                    const txnResult = await runChestTransaction(chestPos, async (chest) => {
                                                        const invBeforeMap = {};
                                                        for (const k of monitoredKeys) invBeforeMap[k] = countInv(k);

                                                        for (const t of takeList) {
                                                            if (typeof chest.withdraw === 'function') {
                                                                try { await chest.withdraw(t.ident, null, t.count); } catch (e) {}
                                                                await wait(120);
                                                            } else {
                                                                try {
                                                                    const slots = (typeof chest.containerItems === 'function') ? chest.containerItems() : (chest && chest.container && Array.isArray(chest.container.slots) ? chest.container.slots : []);
                                                                    for (const s of (slots || [])) {
                                                                        if (!s) continue;
                                                                        const sname = String((s.name || s.displayName || '')).toLowerCase();
                                                                        if (sname === t.nameKey || (s.type && s.type === t.ident)) {
                                                                            const want = t.count;
                                                                            if (typeof chest.withdraw === 'function') {
                                                                                try { await chest.withdraw(s.type || t.ident, null, want); } catch(e) {}
                                                                                await wait(120);
                                                                            }
                                                                            break;
                                                                        }
                                                                    }
                                                                } catch(e) {}
                                                            }
                                                        }

                                                        const invAfterMap = {};
                                                        for (const k of monitoredKeys) invAfterMap[k] = countInv(k);
                                                        return { invBeforeMap, invAfterMap };
                                                    });

                                                    if (!txnResult || !txnResult.ok) continue;

                                                    // update mapping based on actual inventory change and record fetched counts
                                                    try {
                                                        const data = txnResult.result || {};
                                                        const invBeforeMap = data.invBeforeMap || {};
                                                        const invAfterMap = data.invAfterMap || {};
                                                        for (const k of monitoredKeys) {
                                                            const delta = Math.max(0, (invAfterMap[k] || 0) - (invBeforeMap[k] || 0));
                                                            if (delta > 0) {
                                                                try { fetchedThisBatch[k] = (fetchedThisBatch[k] || 0) + delta; } catch (e) {}
                                                                if (chestEntry && chestEntry.items && chestEntry.items[k]) {
                                                                    try {
                                                                        const existing = chestEntry.items[k];
                                                                        if (existing && typeof existing === 'object') {
                                                                            existing.count = Math.max(0, (existing.count || 0) - delta);
                                                                        } else {
                                                                            chestEntry.items[k] = Math.max(0, (Number(existing) || 0) - delta);
                                                                        }
                                                                    } catch (e) {}
                                                                }
                                                            }
                                                        }
                                                    } catch (e) {}
                                                } catch (e) {
                                                    console.warn('[build] chest-level withdraw failed for', chestPos, e && e.message ? e.message : e);
                                                }
                                            }

                                            // Recompute inventory and record leftovers; per-item fallback disabled (chest-by-chest only)
                                            invNow = bot.inventory.items();
                                            const stillLeft = [];
                                            for (const r of prefetchRequests) {
                                                const nowHave2 = countInInventory(invNow, r.nameKey);
                                                const stillNeed2 = Math.max(0, r.toFetch - nowHave2);
                                                if (stillNeed2 > 0) stillLeft.push({ ident: r.ident, nameKey: r.nameKey, need: stillNeed2 });
                                            }
                                            if (stillLeft.length > 0) {
                                                pendingPrefetch = {
                                                    layerMax,
                                                    remaining: stillLeft.reduce((acc, s) => {
                                                        acc[s.nameKey] = { ident: s.ident, need: s.need };
                                                        return acc;
                                                    }, {})
                                                };
                                                try { console.warn('[build] Prefetch incomplete from mapped chests (per-item fallback disabled). Missing:', stillLeft.map(s => s.nameKey)); } catch (e) {}
                                            } else {
                                                pendingPrefetch = null;
                                            }
                                        }
                                    } else {
                                        // No per-chest mapping available: per-item fallback is disabled by policy
                                        try { console.warn('[build] No linked chest mapping available — skipping prefetch (per-item fallback disabled)'); } catch (e) {}
                                    }
                                }
                            }
                        }
                        }
                        // If we actually fetched items this pass, remember the keys so we only re-prefetch
                        try {
                            if (typeof fetchedThisBatch !== 'undefined' && Object.keys(fetchedThisBatch || {}).length > 0) {
                                activePrefetch = { layerY: currentLayer, keys: Object.keys(fetchedThisBatch || {}) };
                            }
                        } catch (e) {}

                        prefetchDone.add(currentLayer);
                    }
                } catch (e) {}

                if (actionsOnLayer.length === 0) {
                    // One correction round at layer end: normal build first, then one traditional re-place round.
                    if (!layerCorrectionDone.has(currentLayer)) {
                        const verification = enqueueLayerCorrections(currentLayer, { enqueue: true });
                        layerCorrectionDone.add(currentLayer);

                        if (verification.mismatches > 0) {
                            const status = verification.enqueued > 0 ? 'queued' : (verification.alreadyQueued > 0 ? 'pending' : 'incomplete');

                            if (verification.enqueued > 0 || verification.alreadyQueued > 0) {
                                layerWaitCounter = 0;
                                await wait(200);
                                continue;
                            }

                            try { await cleanupPathfinderAroundLayer(currentLayer, 'post-verify:depleted-incomplete'); } catch (e) {}
                            emitLayerFinished(currentLayer, 'depleted-incomplete');
                            layerCorrectionDone.delete(currentLayer);
                            currentLayer++;
                            layerWaitCounter = 0;
                            continue;
                        }
                    } else {
                        const postCheck = enqueueLayerCorrections(currentLayer, { enqueue: false });
                        const postStatus = postCheck.mismatches === 0 ? 'ok' : 'incomplete';
                    }

                    // nothing left on this layer, advance
                    try { await cleanupPathfinderAroundLayer(currentLayer, 'post-verify:depleted'); } catch (e) {}
                    emitLayerFinished(currentLayer, 'depleted');
                    layerCorrectionDone.delete(currentLayer);
                    currentLayer++;
                    layerWaitCounter = 0;
                    continue;
                }

                const availableActions = actionsOnLayer.filter(action => {
                    const directions = getPossibleDirections(action.pos);
                    if (directions.length > 0) return true;

                    const desiredHalf = getDesiredSlabHalfFromAction(action);
                    const isTopSlab = !!(action && action.blockName && String(action.blockName).includes('slab') && desiredHalf === 'top');
                    if (isTopSlab) return true;

                    // Allow liaison fallback when no adjacent faces are present.
                    return true;
                });

                if (availableActions.length > 0) {
                    layerWaitCounter = 0;
                }

                if (availableActions.length === 0) {
                    // no immediate placement possible on this layer; wait a short time
                    layerWaitCounter++;
                    if (layerWaitCounter > 5) {
                        // give up on this layer for now and move up
                        try { await cleanupPathfinderAroundLayer(currentLayer, 'post-verify:stalled'); } catch (e) {}
                        emitLayerFinished(currentLayer, 'stalled');
                        layerCorrectionDone.delete(currentLayer);
                        currentLayer++;
                        layerWaitCounter = 0;
                        continue;
                    }
                    await wait(1000);
                    continue;
                }

                const isCreativeMode = !!(bot && bot.game && String(bot.game.gameMode || '').toLowerCase() === 'creative');
                let invCountByName = null;
                if (!isCreativeMode) {
                    invCountByName = {};
                    try {
                        const invItems = bot.inventory.items() || [];
                        for (const it of invItems) {
                            if (!it) continue;
                            const iname = it.name || ((mcData && mcData.itemsById && mcData.itemsById[it.type]) ? mcData.itemsById[it.type].name : null);
                            if (!iname) continue;
                            const key = String(iname).toLowerCase();
                            invCountByName[key] = (invCountByName[key] || 0) + (it.count || 0);
                        }
                    } catch (e) {
                        invCountByName = null;
                    }
                }

                const hasItemForAction = (action) => {
                    if (!invCountByName) return true;
                    let item = null;
                    try { item = build.getItemForState(action.state); } catch (e) { item = null; }
                    const nameKey = (item && item.name) ? String(item.name).toLowerCase() : String(action.blockName || '').toLowerCase();
                    if (!nameKey) return true;
                    return (invCountByName[nameKey] || 0) > 0;
                };

                const classifyPriority = (action) => {
                    const name = String(action && action.blockName ? action.blockName : '').toLowerCase();
                    const isSpecial = name.includes('stairs') || name.includes('trapdoor');
                    const isFenceWallBarrier = name.includes('fence') || name.endsWith('_wall') || name === 'barrier' || name.includes('barrier');
                    const isLadder = false; // temporarily disable ladder special placement

                    // Priority order (ascending = placed earlier):
                    // 0 = normal blocks
                    // 1 = ladders (place near end of layer but before stairs)
                    // 2 = stairs/trapdoors
                    // 3 = fence/wall/barrier (place last)
                    if (isFenceWallBarrier) return 3;
                    if (isSpecial) return 2;
                    if (isLadder) return 1;
                    return 0;
                };

                // Pas de refill automatique - le bot utilise uniquement equipItem pour aller chercher dans les coffres (1 bloc à la fois)
                availableActions.sort((a, b) => {
                    const aPriority = classifyPriority(a);
                    const bPriority = classifyPriority(b);
                    if (aPriority !== bPriority) return aPriority - bPriority;
                    const aHasItem = hasItemForAction(a);
                    const bHasItem = hasItemForAction(b);
                    if (aHasItem !== bHasItem) return aHasItem ? -1 : 1;
                    const distA = a.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position);
                    const distB = b.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position);
                    return distA - distB;
                });

                // Privilégier les actions du même type que l'item tenu (pour vider le stock avant de changer de type)
                let action = availableActions[0];
                const heldType = bot.heldItem && bot.heldItem.type ? bot.heldItem.type : null;
                if (heldType) {
                    for (const candidate of availableActions) {
                        if (!candidate || candidate.type !== 'place') continue;
                        try {
                            const candItem = build.getItemForState(candidate.state);
                            if (candItem && candItem.type === heldType) {
                                action = candidate;
                                break;
                            }
                        } catch (e) {}
                    }
                }
                
                try {
                    if (action.type === 'place') {
                        const item = build.getItemForState(action.state);
                        
                        if (!item) {
                            logActionFailure(action, 'missing-item-for-state');
                            build.actions = build.actions.filter(a => a !== action);
                            continue;
                        }

                        // Pas de refill automatique - equipItem gère la récupération depuis les coffres (1 bloc à la fois)
                        const targetBlock = bot.blockAt(action.pos);
                        if (targetBlock && targetBlock.name === item.name) {
                            build.actions = build.actions.filter(a => a !== action);
                            build.markActionComplete(action);
                            bot.emit('builder_progress', build.getProgress());
                            consecutiveFailures = 0;
                            continue;
                        }

                        if (targetBlock && targetBlock.name !== 'air') {
                            try {
                                const distance = bot.entity.position.distanceTo(action.pos);
                                if (distance > 4.5) {
                                    await gotoNear(action.pos, 3);
                                }
                                try { await equipBestToolForBlock(targetBlock); } catch (e) {}
                                await bot.dig(targetBlock);
                                await wait(200);
                            } catch (e) {
                            }
                        }

                        const blockFacing = getBlockFacing(action.metadata, action.blockName, action.blockProperties, action.blockId);
                        const isStairs = !!(action.blockName && action.blockName.includes('stairs'));
                        const isTrapdoor = !!(action.blockName && action.blockName.includes('trapdoor'));
                        const isLadder = false; // temporarily disable ladder special placement for actions
                        const isSlab = !!(action.blockName && action.blockName.includes('slab'));
                        const slabHalf = isSlab ? getDesiredSlabHalfFromAction(action) : null;
                        const isTopSlab = !!(isSlab && slabHalf === 'top');
                        const axis = blockFacing && blockFacing.axis ? normalizeAxis(blockFacing.axis) : null;
                        const isSpecial = isStairs || isTrapdoor || isLadder;
                        let useSpecialPlacement = isSpecial;
                        let usePreciseStairPathing = false;
                        let forceBasicPlacementForStairs = false;
                        let temporarySupportPos = null;
                        let axisSupportPos = null;
                        let stairLinkResult = null;
                        let topSlabLinkResult = null;
                        let liaisonFallbackResult = null;
                        const placementFacing = blockFacing && blockFacing.facing
                            ? blockFacing.facing
                            : null;
                        // Les échelles nécessitent un bloc adjacent de support au facing indiqué
                        const requiresFacingSupport = !!(placementFacing && (isStairs || isTrapdoor || isLadder));

                        let condition2Handled = false;

                        

                        if (isSpecial && !isLadder && blockFacing && isStairCondition2(action.pos, blockFacing)) {
                            const stairPos = action.pos;
                            const facingPos = action.pos.plus(blockFacing.facing);
                            const behindPos = action.pos.plus(blockFacing.facing.scaled(-1));

                            try {
                                const behindBlock = bot.blockAt(behindPos);
                                if (!behindBlock || behindBlock.name === 'air' || behindBlock.boundingBox === 'empty') {
                                    const behindSupport = await ensureDirtAtPosition(behindPos, 'temporary_support');
                                    if (behindSupport && behindSupport.created) {
                                        temporarySupportPos = behindPos;
                                    }
                                }

                                try {
                                    await gotoNear(behindPos, 1, { antiFreeze: true, antiFreezeMs: 10000 });
                                } catch (e) {
                                    logActionFailure(action, 'stair-condition2-goto-behind', e);
                                }

                                await ensureDirtAtPosition(stairPos, 'temporary_support', {
                                    preferStandPos: behindPos,
                                    skipGoto: true
                                });

                                await ensureDirtAtPosition(facingPos, 'temporary_support');

                                try {
                                    await gotoNear(facingPos, 1, { antiFreeze: true, antiFreezeMs: 10000 });
                                } catch (e) {
                                    logActionFailure(action, 'stair-condition2-goto-facing', e);
                                }

                                try {
                                    const stairBlock = bot.blockAt(stairPos);
                                    if (stairBlock && stairBlock.name !== 'air' && stairBlock.diggable) {
                                        try { await equipBestToolForBlock(stairBlock); } catch (e) {}
                                        await bot.dig(stairBlock);
                                        await wait(200);
                                    }
                                } catch (e) {}

                                const refBlock = bot.blockAt(facingPos);
                                if (!refBlock || refBlock.name === 'air') {
                                    logActionFailure(action, 'stair-condition2-missing-ref');
                                } else {
                                    await bot.builder.equipItem(item.id, { nameHint: item.name || action.blockName });
                                    const face = blockFacing.facing.scaled(-1);
                                    const shouldSneak = isInteractable(refBlock.name);
                                    if (shouldSneak) bot.setControlState('sneak', true);

                                    try {
                                        if (typeof bot.placeSlab === 'function') {
                                            const half = blockFacing && (blockFacing.half === 'top' || blockFacing.half === 'bottom')
                                                ? blockFacing.half
                                                : 'bottom';
                                            await bot.placeSlab(refBlock, face, half);
                                        } else {
                                            await bot.builder.placeBlockTracked(refBlock, face, 'build_action');
                                        }
                                    } finally {
                                        if (shouldSneak) bot.setControlState('sneak', false);
                                    }

                                    await wait(100);
                                    const placedBlock = bot.blockAt(stairPos);
                                    if (placedBlock && placedBlock.name !== 'air') {
                                        let orientationCorrect = true;
                                        if (blockFacing) {
                                            if (blockFacing.half && placedBlock.getProperties) {
                                                const props = placedBlock.getProperties();
                                                if (props.half && props.half !== blockFacing.half) {
                                                    orientationCorrect = false;
                                                }
                                            }
                                        }

                                        if (orientationCorrect) {
                                            build.markActionComplete(action);
                                            consecutiveFailures = 0;
                                        } else {
                                            if (!action.orientationRetries) action.orientationRetries = 0;
                                            action.orientationRetries++;

                                            if (action.orientationRetries < 2) {
                                                build.actions.push({
                                                    ...action,
                                                    pos: action.pos ? new Vec3(action.pos.x, action.pos.y, action.pos.z) : action.pos,
                                                    orientationRetries: action.orientationRetries
                                                });
                                            } else {
                                                build.markActionComplete(action);
                                            }
                                            consecutiveFailures = 0;
                                        }
                                        condition2Handled = true;
                                    } else {
                                        logActionFailure(action, 'placement-produced-air');
                                        build.statistics.blocksFailed++;
                                        consecutiveFailures++;
                                    }
                                }
                            } catch (e) {
                                logActionFailure(action, 'stair-condition2-error', e);
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                            }

                            if (condition2Handled) {
                                try {
                                    await gotoNear(stairPos, 1, { antiFreeze: true, antiFreezeMs: 10000 });
                                } catch (e) {
                                    logActionFailure(action, 'stair-condition2-goto-stair', e);
                                }

                                const cleanupPosList = [facingPos, behindPos];
                                for (const cleanupPos of cleanupPosList) {
                                    try {
                                        const dirtBlock = bot.blockAt(cleanupPos);
                                        if (dirtBlock && dirtBlock.name === 'dirt' && dirtBlock.diggable) {
                                            const supportDistance = bot.entity.position.distanceTo(cleanupPos);
                                            if (supportDistance > 4.5) {
                                                try {
                                                    await gotoNear(cleanupPos, 3, { antiFreeze: true, antiFreezeMs: 10000 });
                                                } catch (e) {}
                                            }
                                            try { await equipBestToolForBlock(dirtBlock); } catch (e) {}
                                            await bot.dig(dirtBlock);
                                            await wait(75);
                                        }
                                    } catch (e) {}
                                }

                                build.actions = build.actions.filter(a => a !== action);
                                bot.emit('builder_progress', build.getProgress());
                                continue;
                            }
                        }

                        usePreciseStairPathing = useSpecialPlacement && shouldUsePrecisePathingForStair(action.pos, blockFacing);

                        const STAIR_IDLE_TIMEOUT_MS = 40000;
                        const STAIR_IDLE_CHECK_MS = 500;
                        const STAIR_MOVE_THRESHOLD_SQ = 0.04 * 0.04;

                        const markBasicStairPlacement = () => {
                            if (!isStairs || forceBasicPlacementForStairs) return;
                            forceBasicPlacementForStairs = true;
                            useSpecialPlacement = isTrapdoor;
                            usePreciseStairPathing = false;
                            console.warn(`[build-stairs] no-move-for=${STAIR_IDLE_TIMEOUT_MS}ms fallback=basic block=${action.blockName} pos=(${action.pos.x},${action.pos.y},${action.pos.z})`);
                        };

                        const runStairStepWithIdleTimeout = async (stepName, stepFn) => {
                            if (!isStairs) {
                                return { timedOut: false, result: await stepFn() };
                            }
                            if (!useSpecialPlacement) {
                                return { timedOut: false, skipped: true };
                            }

                            let lastPos = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
                            let lastMoveAt = Date.now();
                            let interval = null;

                            const timeoutPromise = new Promise((resolve) => {
                                interval = setInterval(() => {
                                    const currentPos = bot.entity && bot.entity.position ? bot.entity.position : null;
                                    if (currentPos && lastPos && currentPos.distanceSquared(lastPos) >= STAIR_MOVE_THRESHOLD_SQ) {
                                        lastPos = currentPos.clone();
                                        lastMoveAt = Date.now();
                                        return;
                                    }

                                    if (Date.now() - lastMoveAt >= STAIR_IDLE_TIMEOUT_MS) {
                                        clearInterval(interval);
                                        interval = null;
                                        try { if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop(); } catch (e) {}
                                        try { if (baritone && typeof baritone.stop === 'function') baritone.stop(); } catch (e) {}
                                        resolve({ timedOut: true });
                                    }
                                }, STAIR_IDLE_CHECK_MS);
                            });

                            const stepPromise = Promise.resolve()
                                .then(() => stepFn())
                                .then((result) => ({ timedOut: false, result }))
                                .catch((error) => ({ timedOut: false, error }));

                            const outcome = await Promise.race([stepPromise, timeoutPromise]);

                            if (interval) {
                                clearInterval(interval);
                                interval = null;
                            }

                            if (outcome && outcome.timedOut) {
                                markBasicStairPlacement();
                                return { timedOut: true };
                            }

                            if (outcome && outcome.error) {
                                throw outcome.error;
                            }

                            return outcome;
                        };

                        let directions = isTopSlab ? getHorizontalDirectionsForPos(action.pos) : getPossibleDirections(action.pos);
                        if (isSlab && slabHalf) directions = filterDirectionsForSlabHalf(directions, slabHalf);
                        if (axis) directions = filterDirectionsForAxis(directions, axis);
                        let requiredSupportPos = null;

                        if (axis && directions.length === 0) {
                            const axisSupport = await ensureAxisSupport(action.pos, axis);
                            if (axisSupport && axisSupport.created) {
                                axisSupportPos = axisSupport.supportPos;
                            }
                            directions = filterDirectionsForAxis(getPossibleDirections(action.pos), axis);
                        }

                        if (requiresFacingSupport) {
                            requiredSupportPos = action.pos.plus(placementFacing.scaled(-1));
                            directions = directions.filter((dir) =>
                                dir.refPos.x === requiredSupportPos.x &&
                                dir.refPos.y === requiredSupportPos.y &&
                                dir.refPos.z === requiredSupportPos.z
                            );
                        }

                        if (directions.length === 0 && isStairs && blockFacing && blockFacing.facing) {
                            const stairSupport = await ensureStairSupportWithLiaison(action.pos, blockFacing);
                            if (stairSupport && stairSupport.ok) {
                                stairLinkResult = stairSupport;
                                directions = getPossibleDirections(action.pos);
                                if (requiredSupportPos) {
                                    directions = directions.filter((dir) =>
                                        dir.refPos.x === requiredSupportPos.x &&
                                        dir.refPos.y === requiredSupportPos.y &&
                                        dir.refPos.z === requiredSupportPos.z
                                    );
                                }
                            } else if (stairSupport && Array.isArray(stairSupport.placedPositions) && stairSupport.placedPositions.length > 0) {
                                stairLinkResult = stairSupport;
                            }
                        }

                        if (directions.length === 0 && useSpecialPlacement) {
                            const supportResult = await runStairStepWithIdleTimeout('stair-support', () =>
                                ensureTemporaryStairSupport(action.pos, blockFacing)
                            );
                            if (supportResult && supportResult.result && supportResult.result.created) {
                                temporarySupportPos = supportResult.result.supportPos;
                            }

                            if (forceBasicPlacementForStairs) {
                                requiredSupportPos = null;
                                directions = getPossibleDirections(action.pos);
                            } else {
                                directions = getPossibleDirections(action.pos);
                                if (requiredSupportPos) {
                                    directions = directions.filter((dir) =>
                                        dir.refPos.x === requiredSupportPos.x &&
                                        dir.refPos.y === requiredSupportPos.y &&
                                        dir.refPos.z === requiredSupportPos.z
                                    );
                                }
                            }
                            if (isSlab && slabHalf) directions = filterDirectionsForSlabHalf(directions, slabHalf);
                        }

                        if (directions.length === 0 && isTopSlab) {
                            const topSlabSupport = await ensureHorizontalSupportForTopSlab(action.pos);
                            if (topSlabSupport && topSlabSupport.ok) {
                                topSlabLinkResult = topSlabSupport;
                                directions = getHorizontalDirectionsForPos(action.pos);
                                if (isSlab && slabHalf) directions = filterDirectionsForSlabHalf(directions, slabHalf);
                            } else {
                                logActionFailure(action, `top-slab-support:${topSlabSupport && topSlabSupport.reason ? topSlabSupport.reason : 'unknown'}`);
                            }
                        }

                        if (directions.length === 0) {
                            const liaisonSupport = await ensureAdjacentSupportWithLiaison(action.pos, {
                                requiredSupportPos,
                                axis
                            });

                            if (liaisonSupport && liaisonSupport.ok) {
                                liaisonFallbackResult = liaisonSupport;
                                directions = getPossibleDirections(action.pos);
                                if (isSlab && slabHalf) directions = filterDirectionsForSlabHalf(directions, slabHalf);
                                if (axis) directions = filterDirectionsForAxis(directions, axis);
                                if (requiredSupportPos) {
                                    directions = directions.filter((dir) =>
                                        dir.refPos.x === requiredSupportPos.x &&
                                        dir.refPos.y === requiredSupportPos.y &&
                                        dir.refPos.z === requiredSupportPos.z
                                    );
                                }
                            } else if (liaisonSupport && Array.isArray(liaisonSupport.placedPositions) && liaisonSupport.placedPositions.length > 0) {
                                liaisonFallbackResult = liaisonSupport;
                            }
                        }
                        
                        if (directions.length === 0) {
                            if (liaisonFallbackResult && settings.cleanupScaffoldImmediately) {
                                try {
                                    await cleanupLiaisonScaffoldPositions(liaisonFallbackResult.placedPositions || []);
                                } catch (e) {
                                }
                            }

                            if (!action.retryCount) action.retryCount = 0;
                            action.retryCount++;
                            
                            if (action.retryCount > settings.maxRetries) {
                                logActionFailure(action, 'no-placement-directions:max-retries');
                                build.actions = build.actions.filter(a => a !== action);
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                            } else {
                                logActionFailure(action, 'no-placement-directions:requeue');
                                build.actions = build.actions.filter(a => a !== action);
                                build.actions.push(action);
                                consecutiveFailures++;
                            }
                            continue;
                        }

                        const selectDirection = () => {
                            let selected = null;
                            if (requiresFacingSupport) {
                                const oppositeSupportPos = action.pos.plus(placementFacing.scaled(-1));
                                selected = directions.find((dir) =>
                                    dir.refPos.x === oppositeSupportPos.x &&
                                    dir.refPos.y === oppositeSupportPos.y &&
                                    dir.refPos.z === oppositeSupportPos.z
                                ) || null;
                            }

                            if (!selected && !usePreciseStairPathing) {
                                for (const dir of directions) {
                                    const faceCenter = dir.refPos.offset(0.5, 0.5, 0.5);
                                    if (hasLineOfSight(bot.entity.position.offset(0, 1.6, 0), faceCenter)) {
                                        selected = dir;
                                        break;
                                    }
                                }
                            }

                            if (!selected && !usePreciseStairPathing) {
                                selected = directions[0];
                            }

                            return selected;
                        };

                        let selectedDirection = selectDirection();

                        if (!selectedDirection) {
                            if (!action.retryCount) action.retryCount = 0;
                            action.retryCount++;

                            if (action.retryCount > settings.maxRetries) {
                                logActionFailure(action, 'no-selected-direction:max-retries');
                                build.actions = build.actions.filter(a => a !== action);
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                            } else {
                                logActionFailure(action, 'no-selected-direction:requeue');
                                build.actions = build.actions.filter(a => a !== action);
                                build.actions.push(action);
                                consecutiveFailures++;
                            }
                            continue;
                        }
                        
                        const distance = bot.entity.position.distanceTo(action.pos);
                        if (distance > 4.5) {
                            try {
                                const nearRange = usePreciseStairPathing ? 1 : (useSpecialPlacement ? 4 : 3);
                                await runStairStepWithIdleTimeout('stair-goto', () =>
                                    gotoNear(action.pos, nearRange, { forcePrecisePathing: usePreciseStairPathing, antiFreeze: isStairs, antiFreezeMs: 10000 })
                                );
                            } catch (e) {
                                logActionFailure(action, 'goto-near-failed', e);
                                build.actions = build.actions.filter(a => a !== action);
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                                continue;
                            }
                        }

                        if (forceBasicPlacementForStairs) {
                            requiredSupportPos = null;
                            directions = getPossibleDirections(action.pos);
                            selectedDirection = selectDirection();
                        }

                        if (useSpecialPlacement && placementFacing) {
                            try {
                                const stairApproachPos = action.pos.plus(placementFacing.scaled(3));
                                const stairApproachRange = usePreciseStairPathing ? 1 : 2;
                                await runStairStepWithIdleTimeout('stair-approach', () =>
                                    gotoNear(stairApproachPos, stairApproachRange, { forcePrecisePathing: usePreciseStairPathing, antiFreeze: isStairs, antiFreezeMs: 10000 })
                                );
                            } catch (e) {
                                if (usePreciseStairPathing) {
                                    logActionFailure(action, 'stair-approach-failed', e);
                                    build.actions = build.actions.filter(a => a !== action);
                                    build.statistics.blocksFailed++;
                                    consecutiveFailures++;
                                    continue;
                                }
                            }
                        }

                        if (forceBasicPlacementForStairs) {
                            requiredSupportPos = null;
                            directions = getPossibleDirections(action.pos);
                            selectedDirection = selectDirection();
                        }

                        if (!selectedDirection) {
                            if (!action.retryCount) action.retryCount = 0;
                            action.retryCount++;

                            if (action.retryCount > settings.maxRetries) {
                                logActionFailure(action, 'no-selected-direction:max-retries');
                                build.actions = build.actions.filter(a => a !== action);
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                            } else {
                                logActionFailure(action, 'no-selected-direction:requeue');
                                build.actions = build.actions.filter(a => a !== action);
                                build.actions.push(action);
                                consecutiveFailures++;
                            }
                            continue;
                        }

                        const { block: refBlock, face } = selectedDirection;

                        // Préparer la liste des prochains types de blocs à poser sur CETTE couche (preshot).
                        // IMPORTANT : trier dans le MÊME ordre que availableActions (priorité puis distance)
                        // pour que le preshot prenne les blocs qui seront réellement posés en premier,
                        // pas des blocs au hasard qui ne seront posés que beaucoup plus tard.
                        const preshotActions = (build.actions || [])
                            .filter(a => a && a.type === 'place' && a.pos && a.pos.y === currentLayer && a !== action)
                            .sort((a, b) => {
                                const aPriority = classifyPriority(a);
                                const bPriority = classifyPriority(b);
                                if (aPriority !== bPriority) return aPriority - bPriority;
                                const aHasItem = hasItemForAction(a);
                                const bHasItem = hasItemForAction(b);
                                if (aHasItem !== bHasItem) return aHasItem ? -1 : 1;
                                const distA = a.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position);
                                const distB = b.pos.offset(0.5, 0.5, 0.5).distanceSquared(bot.entity.position);
                                return distA - distB;
                            });

                        const preshotNeeds = preshotActions
                            .map(a => {
                                try {
                                    const aItem = build.getItemForState(a.state);
                                    const aName = (aItem && aItem.name) ? String(aItem.name).toLowerCase() : String(a.blockName || '').toLowerCase();
                                    return { nameKey: aName, ident: (aItem && aItem.id) ? aItem.id : null };
                                } catch (ex) { return null; }
                            })
                            .filter(n => n && n.nameKey);

                        await bot.builder.equipItem(item.id, { nameHint: item.name || action.blockName, preshotNeeds });

                        // Retourner à la position de construction après avoir été au coffre.
                        // Si on n'arrive pas à revenir à portée, on remet l'action en file
                        // au lieu de tenter un placement à distance (qui échoue et skip).
                        const distAfterEquip = bot.entity.position.distanceTo(action.pos);
                        if (distAfterEquip > 4.5) {
                            try {
                                await gotoNear(action.pos, 3);
                            } catch (e) {}
                            const distAfterReturn = bot.entity.position.distanceTo(action.pos);
                            if (distAfterReturn > 4.5) {
                                logActionFailure(action, 'too-far-after-equip:requeue');
                                if (!action.retryCount) action.retryCount = 0;
                                action.retryCount++;
                                if (action.retryCount > settings.maxRetries) {
                                    build.actions = build.actions.filter(a => a !== action);
                                    build.statistics.blocksFailed++;
                                    consecutiveFailures++;
                                    continue;
                                }
                                build.actions = build.actions.filter(a => a !== action);
                                build.actions.push(action);
                                consecutiveFailures++;
                                continue;
                            }
                        }
                        
                        const faceCenter = refBlock.position.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5));
                        await bot.lookAt(faceCenter);
                        
                        if (placementFacing) {
                            const targetLook = action.pos.offset(0.5, 0.5, 0.5).plus(placementFacing.scaled(0.3));
                            await bot.lookAt(targetLook);
                        }

                        const shouldSneak = isInteractable(refBlock.name);
                        if (shouldSneak) {
                            bot.setControlState('sneak', true);
                        }


                        // --- LOGGING: ANCIEN, NOUVEAU, ET POSÉ ---
                        // 1. Récupère l'ancien facing (avant placement)
                        let oldFacing = null, oldHalf = null, oldAxis = null;
                        const oldBlock = bot.blockAt(action.pos);
                        if (oldBlock && oldBlock.getProperties) {
                            const oldProps = oldBlock.getProperties();
                            oldFacing = oldProps.facing || oldProps.rotation || 'unknown';
                            if (oldProps.half) oldHalf = oldProps.half;
                            else if (oldProps.type) {
                                const t = String(oldProps.type).toLowerCase();
                                if (t === 'top' || t === 'upper') oldHalf = 'top';
                                else if (t === 'bottom' || t === 'lower') oldHalf = 'bottom';
                            } else if (typeof oldProps.top === 'boolean') oldHalf = oldProps.top ? 'top' : 'bottom';
                            else if (typeof oldProps.isTop === 'boolean') oldHalf = oldProps.isTop ? 'top' : 'bottom';
                            if (oldProps.axis) oldAxis = oldProps.axis;
                        }


                        // 2. Plus de rotation/sens appliqué ici
                        let newFacing = null, newHalf = null, newAxis = null;
                        if (action.blockProperties) {
                            newFacing = action.blockProperties.facing || null;
                            newHalf = action.blockProperties.half || null;
                            newAxis = action.blockProperties.axis || null;
                        }
                        // 3. Log avant placement (sans rotation) - removed verbose log

                        // 4. Placement
                        try {
                            if ((isTrapdoor || (isStairs && !forceBasicPlacementForStairs) || isTopSlab) && typeof bot.placeSlab === 'function') {
                                const half = isTopSlab
                                    ? 'top'
                                    : (blockFacing && (blockFacing.half === 'top' || blockFacing.half === 'bottom')
                                        ? blockFacing.half
                                        : 'bottom');
                                await bot.placeSlab(refBlock, face, half);
                            } else {
                                await bot.builder.placeBlockTracked(refBlock, face, 'build_action');
                            }

                            if (shouldSneak) {
                                bot.setControlState('sneak', false);
                            }

                            await wait(100);
                            // 5. Récupère le facing effectivement posé
                            const placedBlock = bot.blockAt(action.pos);
                            let placedFacing = null, placedHalf = null, placedAxis = null;
                            if (placedBlock && placedBlock.getProperties) {
                                const placedProps = placedBlock.getProperties();
                                placedFacing = placedProps.facing || placedProps.rotation || 'unknown';
                                if (placedProps.half) placedHalf = placedProps.half;
                                else if (placedProps.type) {
                                    const t = String(placedProps.type).toLowerCase();
                                    if (t === 'top' || t === 'upper') placedHalf = 'top';
                                    else if (t === 'bottom' || t === 'lower') placedHalf = 'bottom';
                                } else if (typeof placedProps.top === 'boolean') placedHalf = placedProps.top ? 'top' : 'bottom';
                                else if (typeof placedProps.isTop === 'boolean') placedHalf = placedProps.isTop ? 'top' : 'bottom';
                                if (placedProps.axis) placedAxis = placedProps.axis;
                            }
                            // 6. Log après placement - removed verbose log

                            let orientationCorrect = true;
                            if (blockFacing) {
                                if (blockFacing.half && placedBlock && placedBlock.getProperties) {
                                    const props = placedBlock.getProperties();
                                    if (props.half && props.half !== blockFacing.half) {
                                        orientationCorrect = false;
                                    }
                                }
                            }
                            if (isTopSlab) {
                                const actualHalf = getActualHalf(placedBlock);
                                if (actualHalf && actualHalf !== 'top') {
                                    orientationCorrect = false;
                                }
                            }
                            if (orientationCorrect) {
                                build.markActionComplete(action);
                                consecutiveFailures = 0;
                            } else {
                                if (!action.orientationRetries) action.orientationRetries = 0;
                                action.orientationRetries++;
                                if (action.orientationRetries < 2) {
                                    build.actions.push({
                                        ...action,
                                        pos: action.pos ? new Vec3(action.pos.x, action.pos.y, action.pos.z) : action.pos,
                                        orientationRetries: action.orientationRetries
                                    });
                                } else {
                                    build.markActionComplete(action);
                                }
                                consecutiveFailures = 0;
                            }
                        } catch (e) {
                            if (shouldSneak) {
                                bot.setControlState('sneak', false);
                            }
                            logActionFailure(action, 'place-or-verify-error', e);

                            // Ladder-specific fallback: try a basic placeBlock if special placement failed
                            if (isLadder) {
                                try {
                                    console.warn(`[build-ladder-fallback] attempting basic placeBlock at (${action.pos.x},${action.pos.y},${action.pos.z})`);
                                    await bot.builder.equipItem(item.id, { nameHint: item.name || action.blockName });
                                    await bot.placeBlock(refBlock, face);
                                    await wait(100);
                                    const fbPlaced = bot.blockAt(action.pos);
                                    if (fbPlaced && String(fbPlaced.name).toLowerCase().includes('ladder')) {
                                        build.markActionComplete(action);
                                        consecutiveFailures = 0;
                                    } else {
                                        logActionFailure(action, 'ladder-fallback-failed');
                                        build.statistics.blocksFailed++;
                                        consecutiveFailures++;
                                    }
                                } catch (e2) {
                                    logActionFailure(action, 'ladder-fallback-error', e2);
                                    build.statistics.blocksFailed++;
                                    consecutiveFailures++;
                                }
                            } else {
                                build.statistics.blocksFailed++;
                                consecutiveFailures++;
                            }
                        }

                        const supportsMatch = axisSupportPos && temporarySupportPos && axisSupportPos.equals(temporarySupportPos);

                        if (axisSupportPos) {
                            try {
                                const axisSupport = bot.blockAt(axisSupportPos);
                                if (axisSupport && isScaffoldingMaterial(axisSupport.name)) {
                                    if (!isPlacedBlockPartOfActions(axisSupportPos, axisSupport.name)) {
                                        const supportDistance = bot.entity.position.distanceTo(axisSupportPos);
                                        if (supportDistance > 4.5) {
                                            try {
                                                await gotoNear(axisSupportPos, 3);
                                            } catch (e) {
                                            }
                                        }
                                        try { await equipBestToolForBlock(axisSupport); } catch (e) {}
                                        await bot.dig(axisSupport);
                                        await wait(75);
                                    }
                                }
                            } catch (e) {
                            }
                        }

                        if (temporarySupportPos && settings.cleanupScaffoldImmediately && !supportsMatch) {
                            try {
                                const tempSupport = bot.blockAt(temporarySupportPos);
                                if (tempSupport && tempSupport.name === 'dirt') {
                                    const supportDistance = bot.entity.position.distanceTo(temporarySupportPos);
                                    if (supportDistance > 4.5) {
                                        try {
                                            await gotoNear(temporarySupportPos, 3);
                                        } catch (e) {
                                        }
                                    }
                                    try { await equipBestToolForBlock(tempSupport); } catch (e) {}
                                    await bot.dig(tempSupport);
                                    await wait(75);
                                }
                            } catch (e) {
                            }
                        }

                        if (topSlabLinkResult && settings.cleanupScaffoldImmediately) {
                            try {
                                await cleanupLiaisonScaffoldPositions(topSlabLinkResult.placedPositions || []);
                            } catch (e) {
                            }
                        }

                        if (stairLinkResult && settings.cleanupScaffoldImmediately) {
                            try {
                                await cleanupLiaisonScaffoldPositions(stairLinkResult.placedPositions || []);
                            } catch (e) {
                            }
                        }

                        if (liaisonFallbackResult && settings.cleanupScaffoldImmediately) {
                            try {
                                await cleanupLiaisonScaffoldPositions(liaisonFallbackResult.placedPositions || []);
                            } catch (e) {
                            }
                        }

                        // Ne PAS déposer les restes à chaque changement de type (causait un aller-retour
                        // systématique au coffre). Les items restants restent en inventaire et seront
                        // réutilisés par le preshot / les couches suivantes si nécessaire.
                        build.actions = build.actions.filter(a => a !== action);
                        bot.emit('builder_progress', build.getProgress());
                    }

                    if (consecutiveFailures >= maxConsecutiveFailures) {
                        console.warn(`⚠️  Reorganizing queue...`);
                        const toMove = Math.min(20, build.actions.length);
                        for (let i = 0; i < toMove; i++) {
                            const action = build.actions.shift();
                            build.actions.push(action);
                        }
                        consecutiveFailures = 0;
                        await wait(2000);
                    }

                    await wait(1000 / settings.buildSpeed);
                    
                } catch (e) {
                    logActionFailure(action, 'action-loop-error', e);

                    // If the failure is due to missing item (equip/fetch failed), abandon
                    // all remaining actions on this same Y layer that require the same block.
                    try {
                        const emsg = (e && e.message) ? String(e.message) : String(e || '');
                        if (emsg && emsg.includes('Could not get item')) {
                            try {
                                const layerY = action && action.pos && typeof action.pos.y === 'number' ? action.pos.y : null;
                                const missingName = action && action.blockName ? String(action.blockName).toLowerCase() : null;
                                if (layerY !== null && missingName) {
                                    const before = (build.actions || []).length;
                                    const remaining = (build.actions || []).filter(a => {
                                        try {
                                            if (!a || a.type !== 'place' || !a.pos) return true;
                                            if (typeof a.pos.y !== 'number') return true;
                                            if (a.pos.y !== layerY) return true;
                                            const aname = a.blockName ? String(a.blockName).toLowerCase() : null;
                                            return aname !== missingName;
                                        } catch (ex) { return true; }
                                    });
                                    const removed = Math.max(0, before - (remaining ? remaining.length : 0));
                                    if (removed > 0) {
                                        build.actions = remaining;
                                        try { build.statistics = build.statistics || {}; build.statistics.blocksFailed = (build.statistics.blocksFailed || 0) + removed; } catch (ex) {}
                                        console.warn(`[build] Missing block ${missingName} on layer ${layerY}; abandoned ${removed} actions of that block on the layer.`);
                                        try { bot.emit('builder_progress', build.getProgress()); } catch (ex) {}
                                        // skip the standard error-handling path and continue the loop
                                        continue;
                                    }
                                }
                            } catch (ex) {}
                        }
                    } catch (ex) {}

                    console.error('❌ Error:', e && e.message ? e.message : e);
                    bot.emit('builder_error', e);
                    consecutiveFailures++;

                    if (settings.onError === 'pause') {
                        build.pause();
                        bot.emit('builder_paused');
                        break;
                    } else if (settings.onError === 'skip') {
                        build.actions = build.actions.filter(a => a !== action);
                    } else if (settings.onError === 'cancel') {
                        build.cancel();
                        break;
                    }
                }
            }

            if (!build.isCancelled && build.actions.length === 0) {
                bot.emit('builder_finished');
            }
            
        } catch (e) {
            bot.emit('builder_error', e);
        } finally {
            try { await cleanupResidualPathfinderBlocks('build-finalize'); } catch (e) {}
            try { bot.removeListener('diggingCompleted', onDiggingCompletedForActionLog); } catch (e) {}
            try { bot.removeListener('diggingCompleted', onDiggingCompletedForPickup); } catch (e) {}
            try { bot.removeListener('pathfindingBlockPlaced', onPathfindingBlockPlaced); } catch (e) {}
            bot.builder.isBuilding = false;
            currentBuild = null;
        }
    };

    bot.builder.pause = () => {
        if (currentBuild) {
            currentBuild.pause();
            if (typeof baritone.stop === 'function') {
                baritone.stop();
            }
            bot.emit('builder_paused');
        }
    };

    bot.builder.resume = () => {
        if (currentBuild) {
            currentBuild.resume();
            bot.emit('builder_resumed');
        }
    };

    bot.builder.cancel = () => {
        if (currentBuild) {
            currentBuild.cancel();
        }

        if (typeof baritone.stop === 'function') {
            baritone.stop();
        }
    };

    bot.builder.getProgress = () => {
        if (currentBuild) {
            return currentBuild.getProgress();
        }
        return null;
    };
}

module.exports = {
    Build: Build,
    builder: inject,
};
