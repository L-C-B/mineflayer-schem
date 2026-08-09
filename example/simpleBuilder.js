const mineflayer = require('mineflayer');
const baritoneLoader = require('@miner-org/mineflayer-baritone').loader;
const { Build, builder } = require('../index');
const SchematicReader = require('../lib/SchematicReader');
const fs = require('fs').promises;
const path = require('path');

const bot = mineflayer.createBot({
    host: process.argv[2] || 'localhost',
    port: parseInt(process.argv[3]) || 31484,
    username: process.argv[4] || 'Builder',
});

bot.loadPlugin(baritoneLoader);

const builderOptions = {
    buildSpeed: 7.0,
    clearArea: true,
    onError: 'skip',
};

bot.loadPlugin((bot) => builder(bot, builderOptions));

async function startBuilding() {
    try {
        console.log('📖 Reading schematic...');
        
        const schematicPath = path.resolve(__dirname, '../schematic/21981.schematic');
        
        try {
            await fs.access(schematicPath);
        } catch (e) {
            console.error('❌ File not found:', schematicPath);
            console.log('💡 Make sure the file 21981.schematic is in the schematic/ folder');
            return;
        }

        const buffer = await fs.readFile(schematicPath);
        console.log(`✅ File read: ${buffer.length} bytes`);
        
        const schematic = await SchematicReader.read(buffer);
        
        console.log('✅ Schematic loaded successfully');
        
        await bot.waitForChunksToLoad();
        console.log('✅ Chunks loaded');
        
        const buildPosition = bot.entity.position.floored();
        console.log('🏗️  Starting build at:', buildPosition.toString());

        const build = new Build(schematic, bot.world, buildPosition, bot);
        
        bot.on('builder_progress', (progress) => {
            console.log(`📊 Progress: ${progress.percentage}% (${progress.completed}/${progress.total})`);
        });

        bot.on('builder_error', (error) => {
            console.error('❌ Build error:', error.message);
        });

        bot.on('builder_finished', () => {
            console.log('✅ Build completed!');
            const stats = build.statistics;
            console.log(`📊 Statistics:`);
            console.log(`   Blocks placed: ${stats.blocksPlaced}`);
            console.log(`   Blocks failed: ${stats.blocksFailed}`);
            console.log(`   Total time: ${((Date.now() - stats.startTime) / 1000).toFixed(2)}s`);
        });

        await bot.builder.build(build);
        
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        console.error('Stack:', error.stack);
    }
}

bot.once('spawn', () => {
    console.log('✅ Bot connected to the server');
    setTimeout(() => startBuilding().catch(console.error), 2000);
});

bot.on('error', err => console.error('❌ Bot error:', err));
bot.on('kicked', reason => console.log('⚠️  Kicked:', reason));
bot.on('end', () => console.log('🔌 Disconnected'));
