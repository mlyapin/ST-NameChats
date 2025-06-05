import {} from '../../../../script.js'
import { saveMetadataDebounced } from '../../../extensions.js'
const {
  getCurrentChatId,
  renameChat,
  chatMetadata,
  eventTypes,
  eventSource,
  ConnectionManagerRequestService,
  humanizedDateTime,
  renderExtensionTemplateAsync,
} = SillyTavern.getContext();

const MODULE_NAME = 'ChatAutoTitle';

const defaultPrompts = {
  generateTitle: "Suggest a concise title for the following dialogue between a user and an AI assistant. Dont write anything other than the title.",
};

let currentPrompts = { ...defaultPrompts };

async function saveChatAutoTitleSettings() {
  const chatSpecificSettings = chatMetadata[MODULE_NAME] || {};
  chatSpecificSettings.prompts = { ...currentPrompts };
  chatMetadata[MODULE_NAME] = chatSpecificSettings;
  saveMetadataDebounced();
  console.log(`${MODULE_NAME}: Settings saved`);
}

async function loadChatAutoTitleSettings() {

  const chatSpecificSettings = chatMetadata[MODULE_NAME];
  if (chatSpecificSettings && chatSpecificSettings.prompts) {
    currentPrompts = { ...defaultPrompts, ...chatSpecificSettings.prompts };
  } else {
    currentPrompts = { ...defaultPrompts };
  }

  console.log(`${MODULE_NAME}: Settings loaded. Current prompt: "${currentPrompts.generateTitle}"`);

  // Update UI if available
  const generatePromptTextarea = jQuery('#objective-prompt-generate-main');
  if (generatePromptTextarea.length) {
    generatePromptTextarea.val(currentPrompts.generateTitle);
  }
}

async function doRenameChat(args) {
  const currentChatName = getCurrentChatId();
  if (!currentChatName) throw new Error('Cannot rename: no chat ID');
  if (!args?.title || args.title.length < 1) {
    throw new Error('Invalid title');
  }
  const newChatName = `${humanizedDateTime()} - ${args.title.trim()}`;
  await renameChat(currentChatName, newChatName);
  return { title: newChatName };
}

jQuery(async () => {
  // Load settings UI
  try {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-NameChats', 'settings');
    const settingsContainer = jQuery('#extensions_settings');
    if (settingsContainer.length) {
      settingsContainer.append(settingsHtml);
    } else {
      const fallbackContainer = jQuery('<div id="chat_auto_title_settings_container"></div>').appendTo('body');
      fallbackContainer.append(settingsHtml);
    }
    await loadChatAutoTitleSettings();
  } catch (error) {
    console.error(`${MODULE_NAME}: Failed to load settings UI:`, error);
    await loadChatAutoTitleSettings();
  }

  // Settings change handler
  jQuery(document).on('input', '#objective-prompt-generate-main', function() {
    currentPrompts.generateTitle = jQuery(this).val();
    saveChatAutoTitleSettings();
  });

  // Reload settings when chat changes
  eventSource.on(eventTypes.CHAT_CHANGED, async () => {
    console.log(`${MODULE_NAME}: Chat changed - reloading settings`);
    await loadChatAutoTitleSettings();
  });

  // Main title generation logic
  eventSource.on(eventTypes.GENERATE_AFTER_DATA, async () => {
    const ctx = SillyTavern.getContext();

    if (ctx.chat.length === 1) {
      try {
        const promptForTitleLLM = currentPrompts.generateTitle;
        console.log(`${MODULE_NAME}: Generating title with prompt: "${promptForTitleLLM}"`);

        const profileId = 'e183a0f7-3bba-4dc3-b2b0-69587297bfee'; // TODO: Make configurable
        const messages = [{ role: 'user', content: promptForTitleLLM }];
        const maxResponseToken = 50;

        const response = await ConnectionManagerRequestService.sendRequest(
          profileId,
          messages,
          maxResponseToken
        );

        const llmGeneratedTitle = response.content;
        console.log(`${MODULE_NAME}: Generated title: "${llmGeneratedTitle}"`);

        if (llmGeneratedTitle && llmGeneratedTitle.trim().length > 0) {
          await doRenameChat({ title: llmGeneratedTitle.trim() });
          console.log(`${MODULE_NAME}: Chat renamed successfully`);
        } else {
          console.error(`${MODULE_NAME}: Empty title generated`);
        }
      } catch (e) {
        console.error(`${MODULE_NAME}: Title generation failed:`, e);
      }
    }
  });
});
